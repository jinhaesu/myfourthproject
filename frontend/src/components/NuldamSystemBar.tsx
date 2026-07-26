import { useEffect, useState } from "react";

const SYS = [
  { key: "hub", label: "Nuldam Auth Home", url: "https://auth.nuldam.com" },
  { key: "hr", label: "HR", url: "https://hr.nuldam.com" },
  { key: "account", label: "회계", url: "https://account.nuldam.com" },
  { key: "scm", label: "SCM", url: "https://scm.nuldam.com" },
  { key: "pmanage", label: "제품관리", url: "https://pmanage.nuldam.com" },
  { key: "aisystem", label: "현장관리", url: "https://aisystem.nuldam.com" },
  { key: "marketing", label: "마케팅", url: "https://marketing.nuldam.com" },
];

// 허브 /me로 접근 가능한 시스템을 조회해, 권한 없는 시스템은 🔒 잠금 표시한다.
export default function NuldamSystemBar({ current }: { current: string }) {
  const [allowed, setAllowed] = useState<Set<string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("https://auth-api.nuldam.com/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d || !Array.isArray(d.systems)) return;
        setAllowed(new Set(d.systems.map((s: { app_key: string }) => s.app_key)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{position:"sticky",top:0,zIndex:9999,display:"flex",alignItems:"center",gap:4,height:40,padding:"0 12px",background:"#18181b",overflowX:"auto",whiteSpace:"nowrap",fontSize:13}}>
      {SYS.map((s) => {
        const isHub = s.key === "hub";
        const active = s.key === current;
        const accessible = isHub || active || allowed === null || allowed.has(s.key);
        if (accessible) {
          return (
            <a key={s.key} href={s.url} style={{padding:"4px 10px",borderRadius:6,textDecoration:"none",flexShrink:0,marginRight: isHub ? 8 : 0,
              fontWeight: active || isHub ? 700 : 500,
              color: active ? "#fff" : isHub ? "#fff" : "#a1a1aa",
              background: active ? "#2563eb" : "transparent"}}>{s.label}</a>
          );
        }
        return (
          <span key={s.key} title="접근 권한 없음"
            onClick={() => alert(`${s.label} — 접근 권한이 없습니다. 관리자에게 문의하세요.`)}
            style={{padding:"4px 10px",borderRadius:6,flexShrink:0,marginRight: isHub ? 8 : 0,color:"#52525b",cursor:"not-allowed",fontWeight:500}}>{s.label} 🔒</span>
        );
      })}
    </div>
  );
}
