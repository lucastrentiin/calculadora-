idf_component_register(SRCS "src/app_state.c" "src/app_views.c" "src/app_screens.c"
                       INCLUDE_DIRS "include"
                       REQUIRES ai_client authentication calculator camera display keypad ota power_manager privacy_lock settings history wifi
                       PRIV_REQUIRES math_renderer virtual_keyboard favorites formulas conversions math_engine security json)
