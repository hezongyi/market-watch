import type { ReactNode } from "react";

// Exact icon paths from the accepted A07/A06 prototype. No icon library added.
const paths: Record<string, ReactNode> = {
  "/": <path d="M4 4h16v16H4zM8 8h8M8 12h5M8 16h3" />,
  "/chart": (
    <path d="M5 3v18M3 8h4v7H3zM12 2v20M10 6h4v9h-4zM19 4v16M17 10h4v6h-4z" />
  ),
  "/alerts": (
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
  ),
  "/data": (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7" />
    </>
  ),
  "/more": (
    <>
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </>
  ),
  manage: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="8" cy="7" r="2" />
      <circle cx="16" cy="17" r="2" />
    </>
  ),
};
export default function WatchIcon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
