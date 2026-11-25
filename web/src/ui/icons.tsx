// Small line icons, drawn on a 16×16 grid in the current text colour.

import type { JSX } from "solid-js";

function Svg(p: { size?: number; children: JSX.Element; fill?: boolean }) {
  const s = p.size ?? 14;
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 16 16"
      fill={p.fill ? "currentColor" : "none"}
      stroke={p.fill ? "none" : "currentColor"}
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {p.children}
    </svg>
  );
}

export const IconPlay = (p: { size?: number }) => (
  <Svg size={p.size} fill>
    <path d="M4 2.5v11l9.5-5.5z" />
  </Svg>
);
export const IconPause = (p: { size?: number }) => (
  <Svg size={p.size} fill>
    <rect x="3.5" y="2.5" width="3" height="11" />
    <rect x="9.5" y="2.5" width="3" height="11" />
  </Svg>
);
export const IconPlayPause = (p: { size?: number }) => (
  <Svg size={p.size} fill>
    <path d="M1.5 3v10l6-5z" />
    <rect x="9.5" y="3" width="2" height="10" />
    <rect x="12.5" y="3" width="2" height="10" />
  </Svg>
);
export const IconHeadphones = (p: { size?: number }) => (
  <Svg size={p.size}>
    <path d="M2.5 11V8.5a5.5 5.5 0 0 1 11 0V11" />
    <rect x="2" y="10" width="3" height="4" rx="1" />
    <rect x="11" y="10" width="3" height="4" rx="1" />
  </Svg>
);
export const IconGear = (p: { size?: number }) => (
  <Svg size={p.size}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </Svg>
);
export const IconHelp = (p: { size?: number }) => (
  <Svg size={p.size}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.2v.4" />
    <circle cx="8" cy="11.6" r=".4" fill="currentColor" />
  </Svg>
);
export const IconRecord = (p: { size?: number }) => (
  <Svg size={p.size} fill>
    <circle cx="8" cy="8" r="4.5" />
  </Svg>
);
export const IconEject = (p: { size?: number }) => (
  <Svg size={p.size} fill>
    <path d="M8 3l5 5.5H3z" />
    <rect x="3" y="10.5" width="10" height="2" />
  </Svg>
);
export const IconLeft = (p: { size?: number }) => (
  <Svg size={p.size}>
    <path d="M10 3.5L5.5 8 10 12.5" />
  </Svg>
);
export const IconRight = (p: { size?: number }) => (
  <Svg size={p.size}>
    <path d="M6 3.5L10.5 8 6 12.5" />
  </Svg>
);
export const IconFolder = (p: { size?: number }) => (
  <Svg size={p.size}>
    <path d="M1.8 4.2v8.3h12.4V5.6H7.6L6.2 4.2z" />
  </Svg>
);
export const IconPlaylist = (p: { size?: number }) => (
  <Svg size={p.size}>
    <path d="M2 4h8M2 7.5h8M2 11h5" />
    <circle cx="12" cy="11.5" r="1.6" />
    <path d="M13.6 11.5V5l1.4-.6" />
  </Svg>
);
export const IconCollection = (p: { size?: number }) => (
  <Svg size={p.size}>
    <circle cx="8" cy="8" r="6" />
    <circle cx="8" cy="8" r="1.8" />
  </Svg>
);
export const IconRefresh = (p: { size?: number }) => (
  <Svg size={p.size}>
    <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.8v2.6h-2.6" />
  </Svg>
);
export const IconClose = (p: { size?: number }) => (
  <Svg size={p.size}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);
export const IconPlus = (p: { size?: number }) => (
  <Svg size={p.size}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
export const IconSearch = (p: { size?: number }) => (
  <Svg size={p.size}>
    <circle cx="7" cy="7" r="4.2" />
    <path d="M10.2 10.2L13.5 13.5" />
  </Svg>
);
export const IconWarn = (p: { size?: number }) => (
  <Svg size={p.size}>
    <path d="M8 2l6.5 11.5h-13z" />
    <path d="M8 6.5v3.2" />
    <circle cx="8" cy="11.6" r=".4" fill="currentColor" />
  </Svg>
);
export const IconUnlink = (p: { size?: number }) => (
  <Svg size={p.size}>
    <path d="M6.5 9.5l-2 2a2.1 2.1 0 0 1-3-3l2-2M9.5 6.5l2-2a2.1 2.1 0 0 1 3 3l-2 2M3 3l10 10" />
  </Svg>
);
export const IconUsb = (p: { size?: number }) => (
  <Svg size={p.size}>
    <path d="M6 1.5h4v4H6zM4.5 5.5h7v6a3.5 3.5 0 0 1-7 0z" />
    <path d="M7 3h0M9 3h0" />
  </Svg>
);
