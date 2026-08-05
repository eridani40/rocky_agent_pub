// addon.cc —— N-API C++ 薄桥（node-addon-api），把 Swift dylib 的 C ABI 暴露给 Node/Electron。
// 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.2 决策1 + 线程约定
//
// Spike 0：Ping()（同步调 rocky_cu_ping）验证加载 + 调用链。
// Spike 1：Invoke()（Napi::AsyncWorker off 主线程调 rocky_cu_invoke，避免动作类 sleep 阻塞 UI）。
//
// 内存约定：Swift 侧 strdup 返回 char*；此处拷进 std::string 后调 rocky_cu_free 释放（跨界 free 配对）。

#include <napi.h>
#include <string>
#include <utility>

// Swift dylib（libRockyComputerCore.dylib）导出的 @_cdecl C ABI 符号。
extern "C" {
char* rocky_cu_ping(void);
char* rocky_cu_invoke(const char* method, const char* paramsJson);
void rocky_cu_free(char* ptr);
}

namespace {

// 把 Swift 返回的 char*（strdup）拷进 std::string，并释放原指针（rocky_cu_free）。
std::string TakeCString(char* raw) {
  if (raw == nullptr) {
    return std::string();
  }
  std::string out(raw);
  rocky_cu_free(raw);
  return out;
}

// ping() —— 同步健康探针，返回 Swift 侧固定 JSON 字符串。
Napi::Value Ping(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string out = TakeCString(rocky_cu_ping());
  return Napi::String::New(env, out);
}

// InvokeWorker —— off 主线程执行 rocky_cu_invoke（Swift 业务），完成后 resolve Promise<string>。
// 动作类 method（type/pressKey/scroll）内含 Thread.sleep，必须离开 JS/主线程避免卡 UI。
class InvokeWorker : public Napi::AsyncWorker {
 public:
  InvokeWorker(Napi::Env env, std::string method, std::string params)
      : Napi::AsyncWorker(env),
        method_(std::move(method)),
        params_(std::move(params)),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

 protected:
  // libuv 线程池执行（不碰 JS 对象，仅 C ABI 字符串进出）
  void Execute() override {
    result_ = TakeCString(rocky_cu_invoke(method_.c_str(), params_.c_str()));
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    deferred_.Resolve(Napi::String::New(Env(), result_));
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  std::string method_;
  std::string params_;
  std::string result_;
  Napi::Promise::Deferred deferred_;
};

// invoke(method, paramsJson) → Promise<string>（JSON 结果串）
Napi::Value Invoke(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "invoke(method, paramsJson): method must be string")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string method = info[0].As<Napi::String>().Utf8Value();
  std::string params =
      (info.Length() > 1 && info[1].IsString()) ? info[1].As<Napi::String>().Utf8Value() : "{}";

  InvokeWorker* worker = new InvokeWorker(env, method, params);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("ping", Napi::Function::New(env, Ping));
  exports.Set("invoke", Napi::Function::New(env, Invoke));
  return exports;
}

}  // namespace

NODE_API_MODULE(rocky_computer, Init)
