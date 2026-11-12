idf_component_register(SRCS "src/ota_common.c" "src/ota_esp.c" INCLUDE_DIRS "include"
                       PRIV_REQUIRES esp_https_ota esp_http_client app_update esp_app_format json mbedtls log freertos)
