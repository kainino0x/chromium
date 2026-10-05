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
#elif V8_TARGET_OS_WIN
#include <windows.h>
#endif

#include "include/cppgc/allocation.h"
#include "include/v8-cppgc.h"
#include "include/v8-platform.h"
#include "include/v8-template.h"
#include "src/api/api-inl.h"
#include "src/base/platform/platform.h"
#include "src/execution/isolate.h"
#include "src/handles/global-handles-inl.h"
#include "src/init/isolate-group.h"
#include "src/sandbox/sandbox.h"
#include "src/wasm/wasm-memory-map-descriptor.h"
#include "src/wasm/wasm-objects-inl.h"

namespace v8::internal::wasm {

#if V8_TARGET_OS_WIN && defined(V8_ENABLE_SANDBOX)
namespace {

bool SetPersistentMappingProtection(DirectHandle<WasmMemoryObject> memory,
                                    size_t offset, size_t size,
                                    DWORD protection) {
  std::shared_ptr<BackingStore> backing_store = memory->backing_store();
  CHECK_GT(size, 0);
  CHECK_GE(size + offset, size);
  CHECK_LE(size + offset, backing_store->byte_length());
  uint8_t* target =
      reinterpret_cast<uint8_t*>(backing_store->buffer_start()) + offset;
  DWORD old_protection;
  if (!VirtualProtect(target, size, protection, &old_protection)) {
    DWORD error = GetLastError();
    v8::base::OS::PrintError(
        "VirtualProtect(%p, %zu, %lu) failed: %lu\n", target, size,
        static_cast<unsigned long>(protection),
        static_cast<unsigned long>(error));
    return false;
  }
  return true;
}

}  // namespace
#endif  // V8_TARGET_OS_WIN && defined(V8_ENABLE_SANDBOX)

WasmMemoryMapDescriptor::WasmMemoryMapDescriptor(PlatformFileDescriptor fd,
                                                 size_t size,
                                                 FdOwnership fd_ownership)
    : file_descriptor_(fd), size_(size), fd_ownership_(fd_ownership) {}

WasmMemoryMapDescriptor::~WasmMemoryMapDescriptor() {
  CHECK(ReleasePersistentMapping());
  mapped_memory_.Reset();
#if V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID
  // TODO(crbug.com/339678654): Define a constant somewhere in the platform
  // instead of hardcoding -1 here.
  if (fd_ownership_ == FdOwnership::kAnonymousFdOwnedByV8 &&
      file_descriptor_ != -1) {
    close(file_descriptor_);
  }
#elif V8_TARGET_OS_WIN
  if (fd_ownership_ == FdOwnership::kAnonymousFdOwnedByV8 &&
      file_descriptor_ != nullptr) {
    CloseHandle(file_descriptor_);
  }
#else
  USE(fd_ownership_);
#endif
}

bool WasmMemoryMapDescriptor::MatchesFileDescriptor(
    PlatformFileDescriptor fd) const {
#if V8_TARGET_OS_WIN
  // Resolve dynamically to avoid introducing a new import-library dependency.
  using CompareHandles = BOOL(WINAPI*)(HANDLE, HANDLE);
  static auto compare_handles = reinterpret_cast<CompareHandles>(
      GetProcAddress(GetModuleHandleW(L"kernelbase.dll"),
                     "CompareObjectHandles"));
  CHECK_NOT_NULL(compare_handles);
  return compare_handles(file_descriptor_, fd);
#else
  return false;
#endif
}

bool WasmMemoryMapDescriptor::ReleasePersistentMapping() {
#if V8_TARGET_OS_WIN && defined(V8_ENABLE_SANDBOX)
  if (v8_flags.wasm_memory_map_persistent && persistent_backing_store_) {
    uint8_t* target = reinterpret_cast<uint8_t*>(
                          persistent_backing_store_->buffer_start()) +
                      offset_;
    if (!persistent_address_space_->UnmapSharedPagesInPlace(
            reinterpret_cast<uintptr_t>(target), size_,
            v8::PagePermissions::kReadWrite)) {
      v8::base::OS::PrintError("Failed to release persistent mapping at %p\n",
                              target);
      return false;
    }
    persistent_backing_store_.reset();
    persistent_address_space_ = nullptr;
    mapping_active_ = false;
    mapped_memory_.Reset();
  }
#endif
  return true;
}

void WasmMemoryMapDescriptor::Trace(cppgc::Visitor* visitor) const {
  v8::Object::Wrappable::Trace(visitor);
}

// static
v8::Local<v8::Object> WasmMemoryMapDescriptor::NewFromFileDescriptor(
    v8::Isolate* isolate, PlatformFileDescriptor fd, size_t size,
    v8::Local<v8::Object> wrapper, FdOwnership fd_ownership) {
  CHECK(v8_flags.experimental_wasm_memory_control);
#if V8_TARGET_OS_WIN
  if (fd_ownership == FdOwnership::kFdOwnedByEmbedder) {
    HANDLE owned_fd;
    CHECK(DuplicateHandle(GetCurrentProcess(), fd, GetCurrentProcess(),
                          &owned_fd, 0, FALSE, DUPLICATE_SAME_ACCESS));
    fd = owned_fd;
    fd_ownership = FdOwnership::kAnonymousFdOwnedByV8;
  }
#endif
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
#elif V8_TARGET_OS_WIN
  // The section must be a multiple of the allocation granularity (64 KB on
  // Windows) so that Map() can map it in place at that granularity. The extra
  // bytes past `length` stay zero-initialized.
  size_t section_length =
      RoundUp(length, GetArrayBufferPageAllocator()->AllocatePageSize());
  PlatformFileDescriptor fd = CreateFileMapping(
      INVALID_HANDLE_VALUE,  // Backed by RAM/paging file, not disk
      NULL,                  // Default security attributes
      PAGE_READWRITE,        // Read/write access
      static_cast<uint64_t>(section_length) >>
          32,                       // Max size (high-order DWORD)
      section_length & 0xFFFFFFFF,  // Max size (low-order DWORD)
      NULL                          // NULL name makes it completely anonymous
  );
  if (fd == NULL) return {};
  return NewFromFileDescriptor(isolate, fd, length, wrapper,
                               FdOwnership::kAnonymousFdOwnedByV8);
#else
  // WebAssembly memory control is only implemented on Linux, Android, and
  // Windows.
  USE(length);
#endif
}

size_t WasmMemoryMapDescriptor::Map(v8::Isolate* isolate,
                                    DirectHandle<WasmMemoryObject> memory,
                                    size_t offset) {
  CHECK(v8_flags.experimental_wasm_memory_control);
#if V8_TARGET_OS_WIN && defined(V8_ENABLE_SANDBOX)
  if (persistent_backing_store_) {
    if (mapping_active_) {
      isolate->ThrowError("WasmMemoryMapDescriptor::Map called more than once");
      return 0;
    }
    if (!mapped_memory_.IsEmpty() &&
        *Utils::OpenDirectHandle(*mapped_memory_.Get(isolate)) == *memory &&
        persistent_backing_store_ == memory->backing_store() &&
        offset_ == offset) {
      if (v8_flags.wasm_memory_map_protect_persistent &&
          !SetPersistentMappingProtection(memory, offset_, size_,
                                          PAGE_READWRITE)) {
        return 0;
      }
      mapping_active_ = true;
      return size_;
    }
    if (!ReleasePersistentMapping()) {
      return 0;
    }
  }
#endif  // V8_TARGET_OS_WIN && defined(V8_ENABLE_SANDBOX)

  if (!mapped_memory_.IsEmpty()) {
    isolate->ThrowError("WasmMemoryMapDescriptor::Map called more than once");
    return 0;
  }
#if V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID || \
    (V8_TARGET_OS_WIN && defined(V8_ENABLE_SANDBOX))
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
  DCHECK_EQ(reinterpret_cast<uintptr_t>(target) %
               GetArrayBufferPageAllocator()->AllocatePageSize(),
           0);

#if V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID
  static auto ah_size = new std::unordered_map<uintptr_t, size_t>{};
  if (v8_flags.wasm_memory_map_persistent) {
    if (auto it = ah_size->find(reinterpret_cast<uintptr_t>(target));
        it != ah_size->end()) {
      size_t size = it->second;
      if (v8_flags.wasm_memory_map_protect_persistent &&
          mprotect(target, size, PROT_READ | PROT_WRITE) == -1) {
        v8::base::OS::PrintError("mprotect(%p, %zu, RW) failed: %d %s\n",
                                 target, size, errno, strerror(errno));
        return 0;
      }
      mapped_memory_.Reset(isolate, Utils::ToLocal(memory));
      mapped_memory_.SetWeak();
      size_ = size;
      offset_ = offset;
      return size;
    }
  }
#endif  // V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID

#if V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID
  struct stat stat_for_size;
  if (fstat(this->file_descriptor(), &stat_for_size) == -1) {
    // Could not determine file size.
    return 0;
  }
  size_t size = RoundUp(stat_for_size.st_size,
                        GetArrayBufferPageAllocator()->AllocatePageSize());

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
  if (v8_flags.wasm_memory_map_persistent) {
    ah_size->insert({reinterpret_cast<uintptr_t>(target), size});
  }
#elif V8_TARGET_OS_WIN && defined(V8_ENABLE_SANDBOX)
  size_t size =
      RoundUp(size_, GetArrayBufferPageAllocator()->AllocatePageSize());
  if (size == 0) {
    // The descriptor was created from an embedder-provided file mapping without
    // a known size (`size_ == 0`). Determine the size of the mapping object by
    // probe-mapping the whole section (mirrors the Linux `fstat` path).
    void* probe = MapViewOfFile(reinterpret_cast<HANDLE>(file_descriptor_),
                                FILE_MAP_READ, 0, 0, 0);
    if (probe == nullptr) {
      return 0;
    }
    MEMORY_BASIC_INFORMATION mbi{};
    bool queried = VirtualQuery(probe, &mbi, sizeof(mbi)) != 0;
    size_t region_size = mbi.RegionSize;
    UnmapViewOfFile(probe);
    if (!queried) {
      return 0;
    }
    size =
        RoundUp(region_size, GetArrayBufferPageAllocator()->AllocatePageSize());
  }
  if (size + offset < size) {
    // Overflow
    return 0;
  }
  if (size + offset > backing_store->byte_length()) {
    return 0;
  }

  // On Windows the wasm memory lives inside the sandbox cage, whose address
  // space is placeholder-backed. Replace the target sub-range in place with a
  // view of the file mapping (`MapViewOfFile3` cannot overlay committed memory
  // directly, hence we go through the address space which performs the required
  // placeholder split). The cage allocation granularity also requires `offset`
  // to be aligned.
  v8::VirtualAddressSpace* address_space = reinterpret_cast<Isolate*>(isolate)
                                               ->isolate_group()
                                               ->sandbox()
                                               ->address_space();
  if (!IsAligned(offset, address_space->allocation_granularity())) {
    CHECK(false);
    return 0;
  }
  if (!address_space->MapSharedPagesInPlace(
          reinterpret_cast<uintptr_t>(target), size,
          v8::PagePermissions::kReadWrite,
          v8::SharedMemoryHandle::FromPlatformHandle(file_descriptor_),
          /*offset=*/0)) {
    return 0;
  }
  if (v8_flags.wasm_memory_map_persistent) {
    persistent_backing_store_ = backing_store;
    persistent_address_space_ = address_space;
    mapping_active_ = true;
  }
#endif  // V8_TARGET_OS_WIN && defined(V8_ENABLE_SANDBOX)
  mapped_memory_.Reset(isolate, Utils::ToLocal(memory));
  mapped_memory_.SetWeak();
  size_ = size;
  offset_ = offset;

  return size;
#else   // V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID || (V8_TARGET_OS_WIN &&
        // defined(V8_ENABLE_SANDBOX))
  USE(memory);
  USE(offset);
  return 0;
#endif  // V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID || (V8_TARGET_OS_WIN &&
        // defined(V8_ENABLE_SANDBOX))
}

bool WasmMemoryMapDescriptor::Unmap(v8::Isolate* isolate) {
  CHECK(v8_flags.experimental_wasm_memory_control);
#if V8_TARGET_OS_WIN && defined(V8_ENABLE_SANDBOX)
  if (v8_flags.wasm_memory_map_persistent && persistent_backing_store_) {
    DisallowGarbageCollection no_gc;
    if (!mapping_active_) return true;
    if (mapped_memory_.IsEmpty()) {
      return ReleasePersistentMapping();
    }
    if (v8_flags.wasm_memory_map_protect_persistent) {
      DirectHandle<WasmMemoryObject> memory =
          Utils::OpenDirectHandle(*mapped_memory_.Get(isolate));
      if (!SetPersistentMappingProtection(memory, offset_, size_,
                                          PAGE_NOACCESS)) {
        return false;
      }
    }
    mapping_active_ = false;
    return true;
  }
#endif  // V8_TARGET_OS_WIN && defined(V8_ENABLE_SANDBOX)

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
#if V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID || \
    (V8_TARGET_OS_WIN && defined(V8_ENABLE_SANDBOX))
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

#if V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID
  if (v8_flags.wasm_memory_map_persistent) {
    if (v8_flags.wasm_memory_map_protect_persistent &&
        mprotect(target, size, PROT_NONE) == -1) {
      v8::base::OS::PrintError("mprotect(%p, %u, NONE) failed: %d %s\n",
                               target, size, errno, strerror(errno));
      return false;
    }
    return true;
  }

  void* ret_val = mmap(target, size, PROT_READ | PROT_WRITE,
                       MAP_FIXED | MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  printf("unmapped %u bytes at %p\n", size, ret_val);

  CHECK_NE(ret_val, MAP_FAILED);
  CHECK_EQ(ret_val, target);
  return true;
#elif V8_TARGET_OS_WIN && defined(V8_ENABLE_SANDBOX)
  // Restore the previously mapped sub-range to private, zero-initialized pages
  // in place (mirrors the Linux MAP_FIXED | MAP_ANONYMOUS path above).
  v8::VirtualAddressSpace* address_space = reinterpret_cast<Isolate*>(isolate)
                                               ->isolate_group()
                                               ->sandbox()
                                               ->address_space();
  if (!address_space->UnmapSharedPagesInPlace(
          reinterpret_cast<uintptr_t>(target), size,
          v8::PagePermissions::kReadWrite)) {
    return false;
  }
  return true;
#endif
#else   // V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID || (V8_TARGET_OS_WIN &&
        // defined(V8_ENABLE_SANDBOX))
  return false;
#endif  // V8_TARGET_OS_LINUX || V8_TARGET_OS_ANDROID || (V8_TARGET_OS_WIN &&
        // defined(V8_ENABLE_SANDBOX))
}

}  // namespace v8::internal::wasm
