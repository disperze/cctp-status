/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATA_URL?: string;
  readonly VITE_ETH_RPC_URLS?: string;
  readonly VITE_NOBLE_LCD_URLS?: string;
  readonly VITE_SAFETY_MARGIN?: string;
  readonly VITE_ALLOWANCE_WARN_USDC?: string;
  readonly VITE_TREND_WINDOW_HOURS?: string;
  readonly VITE_POLL_SEC?: string;
}
