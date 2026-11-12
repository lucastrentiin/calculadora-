idf_component_register(SRCS "src/wifi_common.c" "src/wifi_esp.c" INCLUDE_DIRS "include"
                       REQUIRES settings
                       PRIV_REQUIRES esp_wifi esp_netif esp_event wifi_provisioning security log freertos esp_timer)
