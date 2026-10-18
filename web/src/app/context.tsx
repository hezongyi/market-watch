import { createContext, useContext } from "react";

export type LeaveGuard = {
  dirty: () => boolean;
  save: () => Promise<void>;
  discard: () => void;
  preserve: () => Promise<void>;
  shouldBlock?: (pathname: string) => boolean;
};
export const AppContext = createContext<{
  registerGuard: (guard: LeaveGuard) => () => void;
  confirmLeave: () => Promise<boolean>;
  logout: () => Promise<void>;
  theme: "dark" | "light";
  setTheme: (theme: "dark" | "light") => void;
  pending: number;
}>({
  registerGuard: () => () => {},
  confirmLeave: async () => true,
  logout: async () => {},
  theme: "dark",
  setTheme: () => {},
  pending: 0,
});
export const useApp = () => useContext(AppContext);
