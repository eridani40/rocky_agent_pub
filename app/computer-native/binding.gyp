{
  "targets": [
    {
      "target_name": "rocky_computer",
      "sources": ["src/addon.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include_dir\")"
      ],
      "cflags_cc!": ["-fno-exceptions"],
      "conditions": [
        ["OS=='mac'", {
          "libraries": [
            "-lRockyComputerCore",
            "-L<(module_root_dir)/swift/.build/release"
          ],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "14.0",
            "OTHER_LDFLAGS": [
              "-Wl,-rpath,@loader_path"
            ]
          }
        }]
      ]
    }
  ]
}
