/**
 * SkeletonLoader — uses the .skeleton utility from design-system.css
 * Usage: <SkeletonLoader lines={3} height="1rem" />
 */
const SkeletonLoader = ({ lines = 1, height = '1rem', gap = '0.5rem', style = {} }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap, ...style }}>
    {Array.from({ length: lines }).map((_, i) => (
      <div
        key={i}
        className="skeleton"
        style={{
          height,
          width: i === lines - 1 && lines > 1 ? '70%' : '100%',
          borderRadius: '6px',
        }}
      />
    ))}
  </div>
);

export default SkeletonLoader;
