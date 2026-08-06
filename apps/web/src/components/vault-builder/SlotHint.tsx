import { colors, radii } from '../../theme';

// "N of M slots filled" progress header shown above a key picker. Empty
// slots render as dashed placeholders -- the visual counterpart to a
// draft vault's key slots being real-but-unfilled rather than blocking
// the rest of the flow. Relocated out of PolicyBuilder.tsx.
export function SlotHint({
  targetCount,
  filledCount,
  role,
}: {
  targetCount: number;
  filledCount: number;
  role: string;
}) {
  if (targetCount <= 0 && filledCount === 0) return null;
  const remaining = Math.max(0, targetCount - filledCount);
  const over = Math.max(0, filledCount - targetCount);
  const complete = targetCount > 0 && filledCount >= targetCount;
  const empties = Array.from({ length: Math.max(0, targetCount - filledCount) });
  const color = complete ? colors.green : colors.gold;

  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 12,
          color: colors.muted,
          marginBottom: 6,
        }}
      >
        <span>
          {filledCount} of {Math.max(targetCount, filledCount)} {role}
          {Math.max(targetCount, filledCount) === 1 ? '' : 's'}
          {complete && ' -- ready'}
          {!complete && targetCount > 0 && ` -- ${remaining} slot${remaining === 1 ? '' : 's'} open`}
          {over > 0 && ` (+${over} above template)`}
        </span>
      </div>
      {empties.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 6 }}>
          {empties.map((_, i) => (
            <div
              key={i}
              style={{
                padding: '8px 10px',
                border: `1px dashed ${color}66`,
                borderRadius: radii.md,
                fontSize: 11,
                color: colors.muted,
                textAlign: 'center',
              }}
            >
              slot {filledCount + i + 1}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
