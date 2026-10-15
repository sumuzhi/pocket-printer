// Non-macOS stub: the module loads but every call reports clearly why.
#include <napi.h>

Napi::Value Unsupported(const Napi::CallbackInfo& info) {
  Napi::Error::New(info.Env(),
                   "本模块只在 macOS 上提供蓝牙支持（依赖 IOBluetooth）")
      .ThrowAsJavaScriptException();
  return info.Env().Undefined();
}

static Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  exports.Set("Rfcomm", Napi::Function::New(env, Unsupported));
  return exports;
}

NODE_API_MODULE(iobt_rfcomm, InitAll)
