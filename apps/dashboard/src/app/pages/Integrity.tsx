import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Link as LinkIcon, Download, Upload, ShieldCheck, ShieldAlert, CircleAlert } from "lucide-react";
import {
  fetchChainHead,
  fetchHeadReceipt,
  verifyReceipt,
  ControlPlaneError,
  CONTROL_PLANE_URL,
  type ChainHead,
  type ConsistencyResult,
} from "../../lib/controlPlane.js";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/card.js";
import { Button } from "../../components/ui/button.js";
import { Skeleton } from "../../components/ui/skeleton.js";

const CONSISTENCY_COPY: Record<ConsistencyResult["code"], { label: string; tone: "good" | "bad" }> = {
  ok: { label: "Consistent", tone: "good" },
  history_rewritten: { label: "History rewritten", tone: "bad" },
  history_truncated: { label: "History truncated", tone: "bad" },
  bad_signature: { label: "Bad signature", tone: "bad" },
  malformed: { label: "Not a receipt", tone: "bad" },
};

export function Integrity(): JSX.Element {
  const [head, setHead] = useState<ChainHead | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [verifyResult, setVerifyResult] = useState<ConsistencyResult | null>(null);
  const [verifyError, setVerifyError] = useState<unknown>(null);
  const [busy, setBusy] = useState<"download" | "verify" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = "Integrity · Provable Agent Spend";
    const ac = new AbortController();
    fetchChainHead(ac.signal)
      .then(setHead)
      .catch((e) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setLoadError(e);
      });
    return () => ac.abort();
  }, []);

  async function download(): Promise<void> {
    setBusy("download");
    try {
      const receipt = await fetchHeadReceipt();
      const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ramp-head-receipt-${receipt.statement.length}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setLoadError(e);
    } finally {
      setBusy(null);
    }
  }

  async function onFile(file: File): Promise<void> {
    setBusy("verify");
    setVerifyError(null);
    setVerifyResult(null);
    try {
      const receipt = JSON.parse(await file.text());
      setVerifyResult(await verifyReceipt(receipt));
    } catch (e) {
      setVerifyError(e instanceof SyntaxError ? new Error("That file isn't valid JSON.") : e);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const intact = head ? head.valid && head.defects === 0 : false;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">Ledger integrity</h1>
        <p className="mt-0.5 max-w-2xl text-[13.5px] text-ink-muted">
          The decision log is a hash chain — each record commits to the one before, so nothing can be altered without
          breaking every link after it. A signed <span className="font-medium text-ink">head receipt</span>, published
          somewhere you don't control, then catches even a self-consistent full rewrite: today's chain must still have that
          head as a prefix.
        </p>
      </div>

      {loadError !== null ? (
        <Card>
          <CardContent className="flex items-start gap-2.5 py-4 text-[13px] text-ink-muted">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-flag" />
            {loadError instanceof ControlPlaneError && loadError.kind === "unavailable" ? (
              <span>
                The demo control plane isn't reachable. Start it with{" "}
                <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[12px]">pnpm control-plane</code> (
                <span className="font-mono text-[12px]">{CONTROL_PLANE_URL}</span>).
              </span>
            ) : (
              <span>{(loadError as Error)?.message ?? "Something went wrong."}</span>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* the head panel */}
      <Card className={head ? (intact ? "border-lime/40" : "border-flag/50") : undefined}>
        <CardContent className="flex flex-wrap items-center gap-x-10 gap-y-4 py-5">
          {head === null && loadError === null ? (
            <Skeleton className="h-14 w-full" />
          ) : head ? (
            <>
              <div className="flex items-center gap-3.5">
                <span
                  className={
                    "flex size-11 items-center justify-center rounded-[12px] " +
                    (intact ? "bg-lime-soft text-lime-ink" : "bg-flag-soft text-flag-ink")
                  }
                >
                  {intact ? <ShieldCheck className="size-6" /> : <ShieldAlert className="size-6" />}
                </span>
                <div className="flex flex-col">
                  <span className="text-[17px] font-semibold text-ink">{intact ? "Chain verified" : "Chain broken"}</span>
                  <span className="text-[12.5px] text-ink-muted">
                    {head.defects === 0 ? "0 tampered links" : `${head.defects} broken link(s)`}
                  </span>
                </div>
              </div>
              <Metric label="Decisions" value={head.length.toLocaleString()} />
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Chain head</span>
                <code className="font-mono text-[13px] text-ink">{head.head.slice(0, 20)}…</code>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* publish */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Publish a head receipt</CardTitle>
              <CardDescription>Download the signed (head, length) and keep it somewhere the operator can't rewrite.</CardDescription>
            </div>
            <LinkIcon className="size-4 shrink-0 text-ink-faint" />
          </CardHeader>
          <CardContent className="flex flex-col gap-3 pt-4">
            <Button variant="secondary" onClick={download} disabled={busy !== null || !head}>
              <Download className="size-4" /> {busy === "download" ? "Signing…" : "Download head receipt"}
            </Button>
            <p className="text-[12px] text-ink-faint">
              A receipt saved next to the database proves nothing — whoever rewrites the chain rewrites it too. The value
              is the copy <span className="font-medium text-ink-muted">you</span> keep off-box.
            </p>
          </CardContent>
        </Card>

        {/* verify */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Verify a receipt</CardTitle>
              <CardDescription>Prove an earlier receipt is still a prefix of today's chain.</CardDescription>
            </div>
            <Upload className="size-4 shrink-0 text-ink-faint" />
          </CardHeader>
          <CardContent className="flex flex-col gap-3 pt-4">
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
            />
            <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={busy !== null}>
              <Upload className="size-4" /> {busy === "verify" ? "Checking…" : "Upload a receipt"}
            </Button>

            {verifyResult ? (
              <div
                className={
                  "flex items-start gap-2.5 rounded-[10px] border px-3.5 py-3 text-[13px] " +
                  (verifyResult.consistent ? "border-lime/40 bg-lime-soft" : "border-flag/40 bg-flag-soft")
                }
              >
                {verifyResult.consistent ? (
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-lime-ink" />
                ) : (
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-flag-ink" />
                )}
                <div className="flex flex-col gap-0.5">
                  <span className={"font-semibold " + (verifyResult.consistent ? "text-lime-ink" : "text-flag-ink")}>
                    {CONSISTENCY_COPY[verifyResult.code]?.label ?? verifyResult.code}
                  </span>
                  <span className="text-ink-muted">{verifyResult.detail}</span>
                </div>
              </div>
            ) : null}
            {verifyError ? (
              <p className="flex items-start gap-2 text-[12.5px] text-ink-muted">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-flag" />
                {(verifyError as Error)?.message ?? "Could not verify that receipt."}
              </p>
            ) : (
              <p className="text-[12px] text-ink-faint">
                Try it: download a receipt above, then upload it back — it verifies. It stays consistent as the chain
                grows, and fails the instant history is rewritten or truncated.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{label}</span>
      <span className="tabular text-[26px] font-semibold leading-none tracking-tight text-ink">{value}</span>
    </div>
  );
}

export default Integrity;
