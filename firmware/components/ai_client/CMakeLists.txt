idf_component_register(SRCS "src/ai_client.c" "src/ai_response.c" "src/ai_transport_esp.c"
                       INCLUDE_DIRS "include"
                       REQUIRES settings json math_renderer
                       PRIV_REQUIRES security math_engine esp_http_client mbedtls log freertos)
