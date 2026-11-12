set(srcs "src/camera_common.c")
if(CONFIG_MT_CAMERA_ENABLE)
  list(APPEND srcs "src/camera_esp.c" "src/camera_preview.c")
else()
  list(APPEND srcs "src/camera_stub_esp.c")
endif()
idf_component_register(SRCS ${srcs} INCLUDE_DIRS "include"
                       PRIV_REQUIRES esp_http_server esp_timer log freertos security espressif__esp32-camera)
