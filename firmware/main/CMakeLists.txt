set(embed "")
if(CONFIG_MT_BACKEND_PINNED_CA)
  set(embed "../certs/backend_ca.pem")
endif()
idf_component_register(SRCS "main.c"
                       INCLUDE_DIRS "."
                       EMBED_TXTFILES ${embed}
                       PRIV_REQUIRES app_state ai_client camera display keypad ota power_manager privacy_lock settings wifi
                                     security nvs_flash esp_netif esp_timer log freertos)
