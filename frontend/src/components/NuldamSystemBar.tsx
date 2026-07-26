const SYS = [
  { key: "hub", label: "늘담 홈", url: "https://auth.nuldam.com" },
  { key: "hr", label: "HR", url: "https://hr.nuldam.com" },
  { key: "account", label: "회계", url: "https://account.nuldam.com" },
  { key: "scm", label: "SCM", url: "https://scm.nuldam.com" },
  { key: "pmanage", label: "제품", url: "https://pmanage.nuldam.com" },
  { key: "aisystem", label: "근태", url: "https://aisystem.nuldam.com" },
  { key: "marketing", label: "마케팅", url: "https://marketing.nuldam.com" },
];
export default function NuldamSystemBar({ current }: { current: string }) {
  return (
    <div style={{position:"sticky",top:0,zIndex:9999,display:"flex",alignItems:"center",gap:4,height:40,padding:"0 12px",background:"#18181b",overflowX:"auto",whiteSpace:"nowrap",fontSize:13}}>
      {SYS.map((s) => {
        const active = s.key === current;
        return (
          <a key={s.key} href={s.url} style={{padding:"4px 10px",borderRadius:6,textDecoration:"none",flexShrink:0,
            fontWeight: active || s.key === "hub" ? 700 : 500,
            color: active ? "#fff" : s.key === "hub" ? "#fff" : "#a1a1aa",
            background: active ? "#2563eb" : "transparent",
            marginRight: s.key === "hub" ? 8 : 0}}>{s.label}</a>
        );
      })}
    </div>
  );
}
