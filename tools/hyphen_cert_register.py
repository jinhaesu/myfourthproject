"""
하이픈 로컬 인증서 등록도구 (인증서 프로그램처럼 자동 탐색·선택).

이 PC에 설치된 공동/금융인증서를 자동으로 찾아 목록으로 보여주고, 하나를 고르면
계좌정보와 비밀번호(이 창에서만 입력)를 받아 서버에 암호화 등록합니다.
- 인증서 비밀번호는 이 PC에서 서버로 TLS 전송되며, 서버는 AES-256으로 암호화 저장(30일 후 자동삭제).
- 웹(하이픈 은행연동)에서 발급한 "1회용 등록코드"가 필요합니다.

실행: python hyphen_cert_register.py
필요: cryptography, httpx  (백엔드에 이미 설치돼 있음)
"""
import os
import sys
import glob
import base64
import getpass

try:
    import httpx
except ImportError:
    print("httpx가 필요합니다: pip install httpx"); sys.exit(1)
try:
    from cryptography import x509
except ImportError:
    print("cryptography가 필요합니다: pip install cryptography"); sys.exit(1)

DEFAULT_BASE = "https://myfourthproject-backend-557811875995.asia-northeast3.run.app"

BANKS = {
    "003": "기업은행", "002": "산업은행", "004": "국민은행", "007": "수협은행",
    "011": "농협은행", "020": "우리은행", "023": "SC제일", "027": "씨티",
    "031": "대구", "032": "부산", "034": "광주", "035": "제주", "037": "전북",
    "039": "경남", "045": "새마을", "048": "신협", "071": "우체국",
    "081": "하나은행", "088": "신한은행", "089": "K뱅크", "090": "카카오뱅크",
    "092": "토스뱅크", "105": "웰컴저축",
}


def find_cert_dirs():
    """표준 NPKI 경로 + 이동식 드라이브에서 (signCert.der, signPri.key) 쌍 폴더 탐색."""
    roots = []
    up = os.path.expanduser("~")
    roots += [
        os.path.join(up, "AppData", "LocalLow", "NPKI"),
        os.path.join(up, "AppData", "Roaming", "NPKI"),
        r"C:\Program Files\NPKI",
        r"C:\Program Files (x86)\NPKI",
    ]
    # 이동식 드라이브 D:~Z:
    for c in "DEFGHIJKLMNOPQRSTUVWXYZ":
        d = f"{c}:\\NPKI"
        if os.path.isdir(d):
            roots.append(d)
        for sub in ("NPKI", "GPKI"):
            dd = f"{c}:\\{sub}"
            if os.path.isdir(dd) and dd not in roots:
                roots.append(dd)

    found = []
    for r in roots:
        if not os.path.isdir(r):
            continue
        # NPKI/<CA>/USER/<cert>/signCert.der
        for der in glob.glob(os.path.join(r, "*", "USER", "*", "signCert.der")):
            key = os.path.join(os.path.dirname(der), "signPri.key")
            if os.path.isfile(key):
                found.append(os.path.dirname(der))
    return found


def cert_info(folder):
    try:
        der = open(os.path.join(folder, "signCert.der"), "rb").read()
        c = x509.load_der_x509_certificate(der)
        cn = ""
        for attr in c.subject:
            if attr.oid._name in ("commonName", "2.5.4.3"):
                cn = attr.value
        return {
            "cn": cn or c.subject.rfc4514_string()[:60],
            "expires": c.not_valid_after_utc.date().isoformat(),
        }
    except Exception as e:
        return {"cn": "(파싱 실패)", "expires": "?", "err": str(e)}


def main():
    print("=" * 60)
    print(" 하이픈 인증서 등록도구 — 이 PC의 공동인증서를 서버에 등록")
    print("=" * 60)

    dirs = find_cert_dirs()
    if not dirs:
        print("\n설치된 인증서를 찾지 못했습니다. (NPKI 폴더/USB 확인)")
        sys.exit(1)

    print(f"\n설치된 인증서 {len(dirs)}개:\n")
    infos = []
    for i, d in enumerate(dirs):
        info = cert_info(d)
        infos.append(info)
        print(f"  [{i+1}] {info['cn']}  (만료 {info['expires']})")

    sel = input(f"\n등록할 인증서 번호 (1-{len(dirs)}): ").strip()
    try:
        idx = int(sel) - 1
        folder = dirs[idx]
    except Exception:
        print("잘못된 선택"); sys.exit(1)

    print(f"\n선택: {infos[idx]['cn']}")

    # 은행/계좌 정보
    print("\n은행코드 예: 003=기업 004=국민 011=농협 020=우리 081=하나 088=신한 090=카카오 092=토스")
    bank_cd = input("은행코드 [003]: ").strip() or "003"
    print(f"  → {BANKS.get(bank_cd, bank_cd)}")
    acct_no = input("계좌번호(숫자만): ").strip().replace("-", "")
    label = input("표시이름(선택, 예: 기업 운영계좌): ").strip()

    # 비밀번호 (이 창에서만 입력)
    print("\n[비밀번호는 이 PC에서만 입력되며 화면에 표시되지 않습니다]")
    acct_pw = getpass.getpass("계좌 비밀번호: ")
    sign_pw = getpass.getpass("인증서 비밀번호: ")

    # 1회용 코드 (웹 '하이픈 은행연동'에서 발급)
    base = input(f"\n서버주소 [{DEFAULT_BASE}]: ").strip() or DEFAULT_BASE
    code = input("웹에서 발급한 1회용 등록코드 붙여넣기: ").strip()

    der_b64 = base64.b64encode(open(os.path.join(folder, "signCert.der"), "rb").read()).decode()
    key_b64 = base64.b64encode(open(os.path.join(folder, "signPri.key"), "rb").read()).decode()

    payload = {
        "code": code,
        "bank_cd": bank_cd,
        "acct_no": acct_no,
        "acct_pw": acct_pw,
        "login_method": "CERT",
        "sign_cert_b64": der_b64,
        "sign_pri_b64": key_b64,
        "sign_pw": sign_pw,
        "label": label or None,
    }
    print("\n서버에 암호화 등록 중...")
    try:
        r = httpx.post(base.rstrip("/") + "/api/v1/hyphen/credentials/by-code", json=payload, timeout=60)
    except Exception as e:
        print(f"통신 실패: {e}"); sys.exit(1)
    if r.status_code >= 400:
        try:
            print("등록 실패:", r.json().get("detail"))
        except Exception:
            print("등록 실패:", r.status_code, r.text[:300])
        sys.exit(1)
    d = r.json()
    print("\n✅ 등록 완료!")
    print(f"   {BANKS.get(d.get('bank_cd'), d.get('bank_cd'))} ****{d.get('acct_last4')}")
    print(f"   인증서: {d.get('cert_subject') or ''}")
    print(f"   보관 만료까지 {d.get('days_left')}일 (이후 재실행으로 재인증)")
    print("\n웹 '하이픈 은행연동'에서 '거래내역 조회'로 확인하세요.")


if __name__ == "__main__":
    main()
