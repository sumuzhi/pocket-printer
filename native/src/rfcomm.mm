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
/**
 * 基带连接完成的回调。
 *
 * 之所以用回调形式（openConnection:target:）而不是同步的 openConnection：
 * 后者是同步阻塞的，且**实测页超时参数无效** —— 对一个不可达的设备，
 * 无论把 pageTimeout 设成 1 秒还是 6.25 秒，它都固定阻塞 15.38 秒
 * （IOBluetooth 栈内部的固定行为）。
 *
 * 异步形式立即返回，于是我们可以在自己的预算内主动放弃，
 * 而不是被栈内部的 15 秒钉住事件循环。
 */
@property (nonatomic, assign) BOOL connectionFinished;
@property (nonatomic, assign) IOReturn connectionStatus;
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
  /**
   * 基带连接用的委托。
   *
   * **必须是成员而不是局部变量**：openConnection:target: 是异步的，
   * 委托释放后连接就失去接管者 —— 表现为基带已连上但
   * openRFCOMMChannelSync 随即超时（实测 0x3758097084）。
   */
  BtDelegate* connDelegate_ = nil;

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
/**
 * 基带连接完成。见头文件里 connectionFinished 的说明：
 * 用异步形式才能在预算内主动放弃，而不是被 IOBluetooth 内部的
 * 15 秒固定超时钉住事件循环。
 */
- (void)connectionComplete:(IOBluetoothDevice*)device status:(IOReturn)status {
  (void)device;
  self.connectionFinished = YES;
  self.connectionStatus = status;
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
  //
  // `openConnection` is synchronous and blocks until the CREATE_CONNECTION
  // command completes, using the **default page timeout** — measured at about
  // 30 seconds against an unreachable device. The 15s deadline below used to be
  // armed *after* that call returned, so it never bounded anything: a probe
  // against a sleeping printer held the Node event loop for the full 30s, and
  // with several paired candidates a single status check took over a minute
  // while every other request was stalled.
  //
  // `openConnection:withPageTimeout:authenticationRequired:` lets us pass the
  // page timeout explicitly. The unit is 0.625 ms, so 8000 ticks ≈ 5s — enough
  // for a printer that is awake (a healthy connection takes well under a
  // second) and short enough that a sleeping one fails fast.
  if (![device isConnected]) {
    /*
     * 用**异步**形式发起连接，然后在自己的预算内等待。
     *
     * 为什么不用同步的 openConnection：它固定阻塞 15.38 秒才失败，而且
     * 实测 pageTimeout 参数对它毫无影响 —— 从 1 秒到 6.25 秒的标称值，
     * 实测一律 15.38 秒（IOBluetooth 栈内部的固定行为）。异步形式立即返回，
     * 于是可以在预算用完时主动 closeConnection 放弃。
     *
     * 预算是 3 秒：健康连接实测 0.7~0.8 秒，留了 4 倍余量；而打印机休眠时
     * 不再让整个 Node 事件循环冻结 15 秒（那期间所有 HTTP 请求都会卡住）。
     */
    connDelegate_ = [[BtDelegate alloc] init];
    connDelegate_.owner = this;
    [device openConnection:connDelegate_];

    const double kConnectBudget = 3.0;
    NSDate* deadline = [NSDate dateWithTimeIntervalSinceNow:kConnectBudget];
    while (![device isConnected] && !connDelegate_.connectionFinished &&
           [deadline timeIntervalSinceNow] > 0) {
      CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, true);
    }

    if (![device isConnected]) {
      // 主动取消仍在进行的连接，避免它稍后突然连上而无人接管。
      [device closeConnection];
      Napi::Error::New(env,
                       "printer unreachable (连接超时 " +
                           std::to_string(kConnectBudget) +
                           "s；打印机可能已休眠，按一下按钮唤醒)")
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
