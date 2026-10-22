/** Minimal 1.5px-stroke icon set drawn on a 20px grid. */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const base = (props: IconProps) => ({
  width: 20,
  height: 20,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'square' as const,
  'aria-hidden': true,
  focusable: false,
  ...props,
});

export const PlayIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 4.5v11l9-5.5z" fill="currentColor" stroke="none" />
  </svg>
);

export const PauseIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 4.5h2.5v11H6zM11.5 4.5H14v11h-2.5z" fill="currentColor" stroke="none" />
  </svg>
);

export const LoopIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 9V7.5A2.5 2.5 0 0 1 6.5 5H15l-2-2M16 11v1.5A2.5 2.5 0 0 1 13.5 15H5l2 2" />
  </svg>
);

export const UploadIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M10 13V3.5M6 7.5l4-4 4 4M3.5 12.5v4h13v-4" />
  </svg>
);

export const FullscreenIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3.5 7.5v-4h4M12.5 3.5h4v4M16.5 12.5v4h-4M7.5 16.5h-4v-4" />
  </svg>
);

export const ExitFullscreenIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M7.5 3.5v4h-4M16.5 7.5h-4v-4M12.5 16.5v-4h4M3.5 12.5h4v4" />
  </svg>
);

export const VolumeIcon = ({ muted, ...p }: IconProps & { muted?: boolean }) => (
  <svg {...base(p)}>
    <path d="M3.5 7.5h3l4-3.5v12l-4-3.5h-3z" />
    {muted ? <path d="M13.5 7.5l4 5M17.5 7.5l-4 5" /> : <path d="M13.5 7a4 4 0 0 1 0 6M15.5 5a7 7 0 0 1 0 10" />}
  </svg>
);

export const SettingsIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 5.5h8M14 5.5h3M3 14.5h3M9 14.5h8M11 3.5v4M9 12.5v4" />
  </svg>
);

export const CloseIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4.5 4.5l11 11M15.5 4.5l-11 11" />
  </svg>
);
