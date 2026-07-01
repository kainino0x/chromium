// Copyright 2026 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#if V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <unordered_map>
// `sys/mman.h defines `MAP_TYPE`, but `MAP_TYPE` also gets defined within V8.
// Since we don't need `sys/mman.h`'s `MAP_TYPE`, we undefine it immediately
// after the `#include`.
#undef MAP_TYPE
#endif  // V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID

#include "include/cppgc/allocation.h"
#include "include/v8-cppgc.h"
#include "include/v8-template.h"
#include "src/api/api-inl.h"
#include "src/base/platform/platform.h"
#include "src/execution/isolate.h"
#include "src/handles/global-handles-inl.h"
#include "src/wasm/wasm-memory-map-descriptor.h"
#include "src/wasm/wasm-objects-inl.h"

namespace v8::internal::wasm {

WasmMemoryMapDescriptor::WasmMemoryMapDescriptor(PlatformFileDescriptor fd,
                                                 size_t size,
                                                 FdOwnership fd_ownership)
    : file_descriptor_(fd), size_(size), fd_ownership_(fd_ownership) {}

WasmMemoryMapDescriptor::~WasmMemoryMapDescriptor() {
  mapped_memory_.Reset();
#if V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID
  // TODO(crbug.com/339678654): Define a constant somewhere in the platform
  // instead of hardcoding -1 here.
  if (fd_ownership_ == FdOwnership::kAnonymousFdOwnedByV8 &&
      file_descriptor_ != -1) {
    close(file_descriptor_);
  }
#else
  USE(fd_ownership_);
#endif
}

void WasmMemoryMapDescriptor::Trace(cppgc::Visitor* visitor) const {
  v8::Object::Wrappable::Trace(visitor);
}

// static
v8::Local<v8::Object> WasmMemoryMapDescriptor::NewFromFileDescriptor(
    v8::Isolate* isolate, PlatformFileDescriptor fd, size_t size,
    v8::Local<v8::Object> wrapper, FdOwnership fd_ownership) {
  CHECK(v8_flags.experimental_wasm_memory_control);
  auto* cpp_descriptor = cppgc::MakeGarbageCollected<WasmMemoryMapDescriptor>(
      isolate->GetCppHeap()->GetAllocationHandle(), fd, size, fd_ownership);

  if (wrapper.IsEmpty()) {
    i::Isolate* i_isolate = reinterpret_cast<i::Isolate*>(isolate);
    v8::Local<v8::ObjectTemplate> templ = Utils::ToLocal(direct_handle(
        i_isolate->native_context()->wasm_memory_map_descriptor_template(),
        i_isolate));

    wrapper = templ->NewInstance(isolate->GetCurrentContext()).ToLocalChecked();
  }

  v8::Object::Wrap<kPointerTag>(isolate, wrapper, cpp_descriptor);

  return wrapper;
}

// static
v8::MaybeLocal<v8::Object> WasmMemoryMapDescriptor::NewFromAnonymous(
    v8::Isolate* isolate, size_t length, v8::Local<v8::Object> wrapper) {
  CHECK(v8_flags.experimental_wasm_memory_control);
#if V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID
  if (__builtin_available(android 30, *)) {
    int fd = memfd_create("wasm_memory_map_descriptor", MFD_CLOEXEC);
    if (fd == -1) return {};
    if (ftruncate(fd, length) == -1) {
      close(fd);
      return {};
    }
    return NewFromFileDescriptor(isolate, fd, length, wrapper,
                                 FdOwnership::kAnonymousFdOwnedByV8);
  }
#endif  // V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID
  return {};
}

#define MODE_PERSISTENT 1
#define MODE_PERSISTENT_MPROTECT 1

size_t WasmMemoryMapDescriptor::Map(v8::Isolate* isolate,
                                    DirectHandle<WasmMemoryObject> memory,
                                    size_t offset) {
  CHECK(v8_flags.experimental_wasm_memory_control);
  if (!mapped_memory_.IsEmpty()) {
    isolate->ThrowError("WasmMemoryMapDescriptor::Map called more than once");
    return 0;
  }
#if V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID
  std::shared_ptr<BackingStore> backing_store = memory->backing_store();
  if (backing_store->is_shared()) {
    // TODO(ahaas): Handle concurrent calls to `MapDescriptor`. To prevent
    // concurrency issues, we disable `MapDescriptor` for shared wasm memories
    // so far.
    return 0;
  }
  if (memory->is_memory64()) {
    // TODO(ahaas): Handle memory64. So far the offset in the
    // MemoryMapDescriptor is only an uint32. Either the offset has to be
    // interpreted as a wasm memory page, or be extended to an uint64.
    return 0;
  }

  uint8_t* target =
      reinterpret_cast<uint8_t*>(backing_store->buffer_start()) + offset;
  CHECK_EQ(reinterpret_cast<uintptr_t>(target) %
               GetArrayBufferPageAllocator()->AllocatePageSize(),
           0);

#if MODE_PERSISTENT
  static auto ah_size = new std::unordered_map<uintptr_t, size_t>{};
  if (auto it = ah_size->find(reinterpret_cast<uintptr_t>(target));
      it != ah_size->end()) {
    size_t size = it->second;
#if MODE_PERSISTENT_MPROTECT
    mprotect(target, size, PROT_READ | PROT_WRITE);
#endif  // MODE_PERSISTENT_MPROTECT
    mapped_memory_.Reset(isolate, Utils::ToLocal(memory));
    mapped_memory_.SetWeak();
    size_ = size;
    offset_ = offset;
    return size;
  }
#endif  // MODE_PERSISTENT

  struct stat stat_for_size;
  if (fstat(this->file_descriptor(), &stat_for_size) == -1) {
    // Could not determine file size.
    return 0;
  }
  size_t size = RoundUp(stat_for_size.st_size,
                        GetArrayBufferPageAllocator()->AllocatePageSize());

#if MODE_PERSISTENT
  ah_size->insert({reinterpret_cast<uintptr_t>(target), size});
#endif  // MODE_PERSISTENT
  if (size + offset < size) {
    // Overflow
    return 0;
  }
  if (size + offset > backing_store->byte_length()) {
    return 0;
  }

  void* ret_val = mmap(target, size, PROT_READ | PROT_WRITE,
                       MAP_FIXED | MAP_SHARED, this->file_descriptor(), 0);
  printf(" mmapped %zu bytes at %p\n", size, ret_val);
  if (ret_val == MAP_FAILED) {
    v8::base::OS::PrintError(
        "MMAP stat result: dev=%lu mode=%u rdev=%lu size=%zu\n",
        static_cast<unsigned long>(stat_for_size.st_dev),
        static_cast<unsigned int>(stat_for_size.st_mode),
        static_cast<unsigned long>(stat_for_size.st_rdev),
        static_cast<size_t>(stat_for_size.st_size));
    v8::base::OS::PrintError("MMAP mmap(%p, %zu, _, _, %d, _) error: %d %s\n",
                             target, size, this->file_descriptor(), errno,
                             strerror(errno));
  }
  CHECK_NE(ret_val, MAP_FAILED);
  CHECK_EQ(ret_val, target);
  mapped_memory_.Reset(isolate, Utils::ToLocal(memory));
  mapped_memory_.SetWeak();
  size_ = size;
  offset_ = offset;
  return size;
#else   // V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID
  USE(memory);
  USE(offset);
  return 0;
#endif  // V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID
}

bool WasmMemoryMapDescriptor::Unmap(v8::Isolate* isolate) {
  CHECK(v8_flags.experimental_wasm_memory_control);
  DisallowGarbageCollection no_gc;
  if (mapped_memory_.IsEmpty()) return false;

  i::DirectHandle<i::WasmMemoryObject> memory =
      Utils::OpenDirectHandle(*mapped_memory_.Get(isolate));
  mapped_memory_.Reset();
  if (memory.is_null()) {
    return true;
  }
  uint32_t offset = static_cast<uint32_t>(offset_);
  uint32_t size = static_cast<uint32_t>(size_);
#if V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID
  std::shared_ptr<BackingStore> backing_store = memory->backing_store();

  // The following checks already passed during `MapDescriptor`, and they should
  // still pass.
  CHECK(!memory->is_memory64());
  CHECK(!backing_store->is_shared());
  CHECK_EQ(size % GetArrayBufferPageAllocator()->AllocatePageSize(), 0);
  CHECK_GE(size + offset, size);
  CHECK_LE(size + offset, backing_store->byte_length());

  uint8_t* target =
      reinterpret_cast<uint8_t*>(backing_store->buffer_start()) + offset;

#if MODE_PERSISTENT
#if MODE_PERSISTENT_MPROTECT
  mprotect(target, size, PROT_NONE);
#endif  // MODE_PERSISTENT_MPROTECT
  (void)target;
  return true;
#else   // MODE_PERSISTENT

  void* ret_val = mmap(target, size, PROT_READ | PROT_WRITE,
                       MAP_FIXED | MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  printf("unmapped %u bytes at %p\n", size, ret_val);

  CHECK_NE(ret_val, MAP_FAILED);
  CHECK_EQ(ret_val, target);
  return true;
#endif  // MODE_PERSISTENT
#else   // V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID
  return false;
#endif  // V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID
}

}  // namespace v8::internal::wasm
