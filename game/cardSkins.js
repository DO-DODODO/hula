// 카드 뒷면 스킨 — 순전히 "내 화면에서 뒷면이 어떻게 보이느냐"는 개인 뷰 설정.
// 서버는 다른 클라이언트에게 남의 스킨을 전달하지 않음(각자 자기 화면에서 자기 스킨으로 렌더링).

const CARD_SKINS = {
  basic: { free: true, label: '기본색' },
  wine: { free: true, label: '와인색' },
  sea: { free: false, singleReq: 10000, multiReq: 1100000, label: '바다' },
  watermelon: { free: false, singleReq: 50000, multiReq: 1300000, label: '수박' },
  dolphin: { free: false, singleReq: 100000, multiReq: 1500000, label: '돌고래' },
};

// 이 스킨을 "메인 스킨"으로 선택 가능한지 — 무료거나, 싱글/멀티 둘 중 하나라도 역대 최고 기준을 채우면 선택 가능
function isSkinSelectable(skinKey, peakSinglePoints, peakMultiBalance) {
  const cfg = CARD_SKINS[skinKey];
  if (!cfg) return false;
  if (cfg.free) return true;
  return peakSinglePoints >= cfg.singleReq || peakMultiBalance >= cfg.multiReq;
}

// 특정 모드(싱글/멀티) 게임 화면에서 이 스킨을 실제로 보여줘도 되는지 — 모드별 독립 체크
function isSkinUsableInMode(skinKey, mode, peakSinglePoints, peakMultiBalance) {
  const cfg = CARD_SKINS[skinKey];
  if (!cfg) return false;
  if (cfg.free) return true;
  return mode === 'multi' ? peakMultiBalance >= cfg.multiReq : peakSinglePoints >= cfg.singleReq;
}

module.exports = { CARD_SKINS, isSkinSelectable, isSkinUsableInMode };
