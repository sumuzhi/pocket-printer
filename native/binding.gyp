{
  "targets": [{
    "target_name": "iobt_rfcomm",
    "sources": [ "src/rfcomm.mm" ],
    "include_dirs": [ "<!@(node -p \"require('node-addon-api').include\")" ],
    "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
    "cflags!": [ "-fno-exceptions" ],
    "cflags_cc!": [ "-fno-exceptions" ],
    "xcode_settings": {
      "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
      "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
      "CLANG_ENABLE_OBJC_ARC": "YES",
      "MACOSX_DEPLOYMENT_TARGET": "11.0"
    },
    "link_settings": { "libraries": [ "-framework Foundation", "-framework IOBluetooth" ] },
    "conditions": [ ["OS!=\"mac\"", { "sources": [ "src/unsupported.cc" ] }] ]
  }]
}
