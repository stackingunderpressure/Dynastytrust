import { APP_NAME } from '../config';
import { colors, fonts } from '../theme';

export function LoadingScreen() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <span
        style={{
          fontFamily: fonts.display,
          fontSize: 22,
          letterSpacing: '0.14em',
          color: colors.gold,
        }}
      >
        {APP_NAME}
      </span>
    </div>
  );
}
