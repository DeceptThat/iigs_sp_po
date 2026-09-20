const PATHS = {
  leaf: 'M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12',
  home: 'm3 11 9-8 9 8 M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5 M9.5 21v-6h5v6',
  pulse: 'M2 12h4l3-8 4 16 3-8h6',
  sliders: 'M4 7h16 M4 12h16 M4 17h16',
  camera: 'M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z',
  chart: 'M5 20h14 M6.5 20v-6 M11 20V9 M15.5 20v-8 M18.5 20V6',
  bell: 'M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6 M10 19a2 2 0 0 0 4 0',
  users: 'M9 8a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 8Z M3 20c0-3.5 2.7-5.5 6-5.5s6 2 6 5.5',
  droplet: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z',
  thermo: 'M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z',
  zap: 'M13 2 4 14h6l-1 8 9-12h-6l1-8Z',
  shield: 'M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z',
  alert: 'M12 4 2.5 20h19L12 4Z M12 10v4 M12 17h.01',
  bulb: 'M9 18h6 M10 21h4 M12 3a6 6 0 0 1 3.5 10.9c-.8.6-1 1.3-1 2.1h-5c0-.8-.2-1.5-1-2.1A6 6 0 0 1 12 3Z',
  check: 'm5 13 4 4L19 7',
  trash: 'M4 7h16 M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2 M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13',
  save: 'M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z M8 4v5h7V4 M8 20v-6h8v6',
  undo: 'M9 14 4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  menu: 'M4 7h16M4 12h16M4 17h16',
  chevR: 'm9 6 6 6-6 6',
  chevL: 'm15 6-6 6 6 6',
};

export function Icon({ name, size = 18, stroke = 1.7 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name] || PATHS.leaf} />
    </svg>
  );
}