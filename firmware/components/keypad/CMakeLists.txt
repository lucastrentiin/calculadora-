idf_component_register(SRCS "src/keypad_core.c" "src/keypad_matrix_esp.c" "src/keypad_console_esp.c"
                       INCLUDE_DIRS "include" PRIV_REQUIRES driver esp_driver_gpio esp_timer log freertos)
