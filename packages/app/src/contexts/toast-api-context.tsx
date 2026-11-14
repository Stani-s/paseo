import { createContext, useContext, type ReactNode } from "react";
import type { ToastApi } from "@/components/toast-host";

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return value;
}

/**
 * For actions that can render without a host, such as stream rows shown in isolated
 * test and preview hosts: errors surface wherever a toast host does exist.
 */
export function useToastOptional(): ToastApi | null {
  return useContext(ToastContext);
}

export function ToastApiProvider({ api, children }: { api: ToastApi; children: ReactNode }) {
  return <ToastContext.Provider value={api}>{children}</ToastContext.Provider>;
}
