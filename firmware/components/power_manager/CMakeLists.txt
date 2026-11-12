idf_component_register(SRCS "src/power_manager.c" "src/power_esp.c" INCLUDE_DIRS "include"
                       PRIV_REQUIRES esp_adc esp_hw_support esp_system keypad log)
