// Copyright 2026 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef V8_WASM_WASM_MEMORY_MAP_DESCRIPTOR_H_
#define V8_WASM_WASM_MEMORY_MAP_DESCRIPTOR_H_

#include "include/v8-cppgc.h"
#include "include/v8-object.h"
#include "include/v8-wasm.h"
#include <memory>
#include "src/handles/handles.h"
#include "src/objects/js-objects.h"

namespace v8::internal::wasm {

class WasmMemoryMapDescriptor final : public v8::Object::Wrappable {
 public:
  static constexpr v8::CppHeapPointerTag kPointerTag =
      v8::CppHeapPointerTag::kWasmMemoryMapDescriptorTag;

  using PlatformFileDescriptor =
      v8::WasmMemoryMapDescriptor::WasmFileDescriptor;

  enum class FdOwnership {
    kAnonymousFdOwnedByV8,
    kFdOwnedByEmbedder,
  };

  WasmMemoryMapDescriptor(PlatformFileDescriptor fd, size_t size,
                          FdOwnership fd_ownership);
  ~WasmMemoryMapDescriptor() override;

  // Creates a wrapped JSObject encapsulating the WasmMemoryMapDescriptor C++
  // object.
  static v8::Local<v8::Object> NewFromFileDescriptor(
      v8::Isolate* isolate, PlatformFileDescriptor fd, size_t size = 0,
      v8::Local<v8::Object> wrapper = {},
      FdOwnership fd_ownership = FdOwnership::kFdOwnedByEmbedder);

  static v8::MaybeLocal<v8::Object> NewFromAnonymous(
      v8::Isolate* isolate, size_t length, v8::Local<v8::Object> wrapper = {});

  // Returns the number of bytes that got mapped into the WebAssembly.Memory, or
  // 0 if an error occurred.
  size_t Map(v8::Isolate* isolate, DirectHandle<WasmMemoryObject> memory,
             size_t offset);

  // Returns `false` if an error occurred, otherwise `true`.
  bool Unmap(v8::Isolate* isolate);

  bool MatchesFileDescriptor(PlatformFileDescriptor fd) const;
  bool ReleasePersistentMapping();

  // Trace method for Oilpan garbage collection.
  void Trace(cppgc::Visitor* visitor) const override;

  // Accessors.
  PlatformFileDescriptor file_descriptor() const { return file_descriptor_; }
  size_t offset() const { return offset_; }
  size_t size() const { return size_; }

 private:
  PlatformFileDescriptor file_descriptor_;
  // After mapping the file descriptor, we store the offset and size so that we
  // can unmap the memory at the same position.
  size_t offset_;
  size_t size_;
  // Own anonymous file descriptors and duplicated embedder handles on Windows;
  // close them in the destructor.
  FdOwnership fd_ownership_;

  // Weak reference to the mapped WasmMemoryObject.
  v8::Global<v8::WasmMemoryObject> mapped_memory_;

#if V8_TARGET_OS_WIN && defined(V8_ENABLE_SANDBOX)
  // Keep the allocation alive until its retained view is explicitly released.
  std::shared_ptr<BackingStore> persistent_backing_store_;
  v8::VirtualAddressSpace* persistent_address_space_ = nullptr;
  bool mapping_active_ = false;
#endif
};

}  // namespace v8::internal::wasm

#endif  // V8_WASM_WASM_MEMORY_MAP_DESCRIPTOR_H_
