export function Grid({ children, cols }: { children: React.ReactNode; cols?: number }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(${cols || 140}px, 1fr))`,
        gap: 8,
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}
