// iobt_rfcomm — minimal ObjC++ N-API wrapper around IOBluetooth RFCOMM (SPP).
//
// Design note (the crux of this whole exercise):
//   IOBluetooth delivers RFCOMM data through *delegate callbacks*, and those
//   callbacks are dispatched by the CFRunLoop of the thread that opened the
//   channel. Node's main thread runs libuv, not CFRunLoop, so a naive addon
//   never receives a single byte. The fix used here is to service the main
//   thread's CFRunLoop from a uv_timer: libuv keeps running, and the run loop
//   gets drained every few milliseconds so delegate callbacks fire.
//
// This is a skeleton: no reconnection policy, no backpressure, no MTU-aware
// write loop beyond a simple chunker.

#include <napi.h>
#include <uv.h>

#import <Foundation/Foundation.h>
#import <IOBluetooth/IOBluetooth.h>

#include <cstdint>
#include <string>
#include <vector>

class Rfcomm;

// Defined after Rfcomm; declared here because Rfcomm::Init exports it.
Napi::Value PairedDevices(const Napi::CallbackInfo& info);

// ---------------------------------------------------------------------------
// Run loop pump
// ---------------------------------------------------------------------------
static uv_timer_t g_pump;
static bool g_pumpStarted = false;

static void PumpCb(uv_timer_t*) {
  // timeout 0 + returnAfterSourceHandled=true => drain without blocking libuv.
  CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0, true);
}

static void EnsurePump() {
  if (g_pumpStarted) return;
  uv_timer_init(uv_default_loop(), &g_pump);
  uv_timer_start(&g_pump, PumpCb, 5 /*ms*/, 5 /*ms*/);
  g_pumpStarted = true;
}

// ---------------------------------------------------------------------------
// Delegate
// ---------------------------------------------------------------------------
@interface BtDelegate : NSObject <IOBluetoothRFCOMMChannelDelegate>
@property (nonatomic, assign) Rfcomm* owner;
@end

// ---------------------------------------------------------------------------
// Wrapped object
// ---------------------------------------------------------------------------
class Rfcomm : public Napi::ObjectWrap<Rfcomm> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  explicit Rfcomm(const Napi::CallbackInfo& info);

  // Called from the delegate — always on the main thread (we pump it there).
  void OnData(const uint8_t* bytes, size_t len);
  void OnClosed();

 private:
  Napi::Value Connect(const Napi::CallbackInfo& info);
  Napi::Value Write(const Napi::CallbackInfo& info);
  Napi::Value Close(const Napi::CallbackInfo& info);
  Napi::Value GetMtu(const Napi::CallbackInfo& info);
  Napi::Value On(const Napi::CallbackInfo& info);

  IOBluetoothRFCOMMChannel* channel_ = nil;
  BtDelegate* delegate_ = nil;
  Napi::FunctionReference dataCb_;
  Napi::FunctionReference closeCb_;
};

@implementation BtDelegate
- (void)rfcommChannelData:(IOBluetoothRFCOMMChannel*)ch
                     data:(void*)dataPointer
                   length:(size_t)dataLength {
  (void)ch;
  if (self.owner) self.owner->OnData(static_cast<const uint8_t*>(dataPointer), dataLength);
}
// NOTE: `length:` above is size_t (64-bit). Declaring it UInt16 silently
// truncates and every frame reads as length 0 — indistinguishable from a mute
// device. Do not "simplify" this signature.
- (void)rfcommChannelClosed:(IOBluetoothRFCOMMChannel*)ch {
  (void)ch;
  if (self.owner) self.owner->OnClosed();
}
- (void)rfcommChannelWriteComplete:(IOBluetoothRFCOMMChannel*)ch
                            refcon:(void*)refcon
                            status:(IOReturn)error {
  (void)ch; (void)refcon; (void)error;
}
@end

void Rfcomm::OnData(const uint8_t* bytes, size_t len) {
  if (len == 0 || dataCb_.IsEmpty()) return;
  Napi::Env env = dataCb_.Env();
  Napi::HandleScope scope(env);
  dataCb_.Call({Napi::Buffer<uint8_t>::Copy(env, bytes, len)});
}

void Rfcomm::OnClosed() {
  if (closeCb_.IsEmpty()) return;
  Napi::Env env = closeCb_.Env();
  Napi::HandleScope scope(env);
  closeCb_.Call({});
}

Rfcomm::Rfcomm(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Rfcomm>(info) {}

Napi::Value Rfcomm::On(const Napi::CallbackInfo& info) {
  std::string ev = info[0].As<Napi::String>().Utf8Value();
  Napi::Function fn = info[1].As<Napi::Function>();
  if (ev == "data") {
    dataCb_ = Napi::Persistent(fn);
  } else if (ev == "closed") {
    closeCb_ = Napi::Persistent(fn);
  }
  return info.This();
}

Napi::Value Rfcomm::Connect(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string address = info[0].As<Napi::String>().Utf8Value();
  int channel = info[1].As<Napi::Number>().Int32Value();

  EnsurePump();

  NSString* addr = [NSString stringWithUTF8String:address.c_str()];
  IOBluetoothDevice* device = [IOBluetoothDevice deviceWithAddressString:addr];
  if (device == nil) {
    Napi::Error::New(env, "device not found (is it paired?)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // 1) Baseband connection first.
  if (![device isConnected]) {
    IOReturn cr = [device openConnection];
    NSDate* deadline = [NSDate dateWithTimeIntervalSinceNow:15.0];
    while (![device isConnected] && [deadline timeIntervalSinceNow] > 0) {
      CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, true);
    }
    if (![device isConnected]) {
      Napi::Error::New(env, "printer unreachable (openConnection 0x" +
                                std::to_string((unsigned)cr) + ")")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  // 2) RFCOMM channel.
  delegate_ = [[BtDelegate alloc] init];
  delegate_.owner = this;
  IOBluetoothRFCOMMChannel* ch = nil;
  IOReturn r = [device openRFCOMMChannelSync:&ch withChannelID:(BluetoothRFCOMMChannelID)channel
                                    delegate:delegate_];
  if (r != kIOReturnSuccess || ch == nil) {
    Napi::Error::New(env, "openRFCOMMChannelSync failed 0x" + std::to_string((unsigned)r))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  channel_ = ch;
  return Napi::Boolean::New(env, true);
}

Napi::Value Rfcomm::Write(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (channel_ == nil) {
    Napi::Error::New(env, "not connected").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Buffer<uint8_t> buf = info[0].As<Napi::Buffer<uint8_t>>();
  UInt16 mtu = [channel_ getMTU];

  size_t offset = 0;
  while (offset < buf.Length()) {
    size_t remaining = buf.Length() - offset;
    UInt16 chunk = (UInt16)((remaining > mtu) ? mtu : remaining);
    IOReturn r = [channel_ writeSync:(void*)(buf.Data() + offset) length:chunk];
    if (r != kIOReturnSuccess) {
      Napi::Error::New(env, "writeSync failed 0x" + std::to_string((unsigned)r))
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    offset += chunk;
  }
  return Napi::Number::New(env, (double)buf.Length());
}

Napi::Value Rfcomm::GetMtu(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (channel_ == nil) return Napi::Number::New(env, 0);
  return Napi::Number::New(env, (double)[channel_ getMTU]);
}

Napi::Value Rfcomm::Close(const Napi::CallbackInfo& info) {
  if (channel_ != nil) {
    [channel_ closeChannel];
    channel_ = nil;
  }
  return info.Env().Undefined();
}

Napi::Object Rfcomm::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function fn = DefineClass(
      env, "Rfcomm",
      {
          InstanceMethod("connect", &Rfcomm::Connect),
          InstanceMethod("write", &Rfcomm::Write),
          InstanceMethod("close", &Rfcomm::Close),
          InstanceMethod("mtu", &Rfcomm::GetMtu),
          InstanceMethod("on", &Rfcomm::On),
      });
  exports.Set("Rfcomm", fn);
  exports.Set("pairedDevices", Napi::Function::New(env, PairedDevices));
  return exports;
}

// List Bluetooth devices the system already knows about.
//
// This exists so the printer can be found without asking the user for a MAC
// address. `IOBluetoothDevice.pairedDevices` is the authoritative list of
// paired devices; `recentDevices` adds ones seen but not paired. Both are
// returned, flagged, because a printer that was paired on another machine (or
// re-flashed) can appear as "recent" only.
//
// Nothing here is printer-specific: the caller identifies the printer by
// connecting and speaking the protocol, which is the only reliable signal.
Napi::Value PairedDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array out = Napi::Array::New(env);

  // Servicing the run loop briefly lets IOBluetooth populate its caches;
  // immediately after process start the lists can be empty.
  EnsurePump();
  CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0, true);

  uint32_t n = 0;
  auto append = [&](NSArray* list, bool paired) {
    if (list == nil) return;
    for (IOBluetoothDevice* d in list) {
      if (d == nil) continue;
      Napi::Object entry = Napi::Object::New(env);
      NSString* addr = [d addressString];
      NSString* name = [d name];
      entry.Set("address", Napi::String::New(env, addr ? [addr UTF8String] : ""));
      entry.Set("name", Napi::String::New(env, name ? [name UTF8String] : ""));
      entry.Set("paired", Napi::Boolean::New(env, paired));
      entry.Set("connected", Napi::Boolean::New(env, [d isConnected]));
      out.Set(n++, entry);
    }
  };

  @try {
    append([IOBluetoothDevice pairedDevices], true);
  } @catch (NSException* e) {
    // Not fatal: fall through to the recent list.
  }
  @try {
    append([IOBluetoothDevice recentDevices:10], false);
  } @catch (NSException* e) {
  }

  return out;
}

// NODE_API_MODULE token-pastes the init function's name, so it must be a plain
// identifier (a qualified name like Rfcomm::Init will not compile).
static Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return Rfcomm::Init(env, exports);
}

NODE_API_MODULE(iobt_rfcomm, InitAll)
