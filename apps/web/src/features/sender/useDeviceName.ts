import { useEffect, useRef, useState } from 'react';
import { fetchDeviceNamesInUse } from '@/lib/ivs/mediaApi';
import { deviceNameOptions, firstFreeName, type SenderKind } from './engine/deviceName';

/**
 * 端末名の選択状態。初期値は他のユーザーが使っていない最初の名前にする（R3-01）。
 * 例: 他の人が MIC1 で送信中なら MIC2 を初期表示する。取得に失敗したら先頭のまま。利用者が選び直した後は上書きしない。
 */
export function useDeviceName(kind: SenderKind) {
  const options = deviceNameOptions(kind);
  const [deviceName, setDeviceName] = useState(options[0] ?? '');
  const touched = useRef(false);
  useEffect(() => {
    let cancelled = false;
    fetchDeviceNamesInUse(kind)
      .then(({ inUse }) => { if (!cancelled && !touched.current) setDeviceName(firstFreeName(deviceNameOptions(kind), inUse)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [kind]);
  const select = (value: string) => {
    touched.current = true;
    setDeviceName(value);
  };
  return { options, deviceName, setDeviceName: select };
}
