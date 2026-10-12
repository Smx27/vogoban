#!/usr/bin/env python3
"""Phase 17 real-repository verification: cold/warm analysis with time and peak memory, Azure plugin timings,
and Azure fact counts per repository. Usage: azure_verify.py <work-dir> <repo-dir>..."""
import json, os, re, sqlite3, subprocess, sys, time

VOGOBAN = os.path.join(os.path.dirname(__file__), "..", "..", "..", "src", "cli", "main.ts")

def analyze(repo, db):
    t0 = time.time()
    p = subprocess.run(["/usr/bin/time", "-f", "%M", "bun", VOGOBAN, "analyze", repo, "--db", db, "--log-json"], capture_output=True, text=True)
    rss = int((p.stderr.strip().splitlines() or ["0"])[-1]) // 1024 if p.stderr.strip().splitlines()[-1:][0].isdigit() else None
    return round(time.time() - t0, 1), rss, p.returncode

def q(c, sql):
    return c.execute(sql).fetchone()[0]

def main():
    work, repos = sys.argv[1], sys.argv[2:]
    os.makedirs(work, exist_ok=True)
    rows = []
    for repo in repos:
        name = os.path.basename(repo.rstrip("/"))
        db = os.path.join(work, f"{name}.db")
        for s in ("", "-wal", "-shm"):
            if os.path.exists(db + s): os.remove(db + s)
        cold, rss, rc = analyze(repo, db)
        warm, warm_rss, _ = analyze(repo, db)
        c = sqlite3.connect(db)
        stats = json.loads(q(c, "select stats from runs order by finished_at desc limit 1") or "{}")
        ms = {k[3:]: v for k, v in stats.items() if k.startswith("ms:azure.")}
        cold_stats = json.loads(c.execute("select stats from runs order by finished_at asc limit 1").fetchone()[0])
        row = {
            "repository": name, "rc": rc, "coldSeconds": cold, "coldPeakMB": rss, "warmSeconds": warm,
            "azurePluginMsCold": {k[3:]: v for k, v in cold_stats.items() if k.startswith("ms:azure.")}, "azurePluginMsWarm": ms,
            "functions": q(c, "select count(*) from entities where kind='AzureFunction'"),
            "triggers": dict(c.execute("select json_extract(metadata,'$.triggerType'), count(*) from entities where kind='AzureFunction' group by 1").fetchall()),
            "functionsWithTriggerSource": q(c, "select count(distinct target_id) from relationships where type in ('TRIGGERS','CHANGE_FEED') and target_id in (select id from entities where kind='AzureFunction')"),
            "bindings": q(c, "select count(*) from relationships where source_id in (select id from entities where kind='AzureFunction') and type in ('READS_FROM','WRITES_TO','PUBLISHES_TO','PUBLISHES_EVENT')"),
            "durable": q(c, "select count(*) from relationships where type in ('INVOKES_ACTIVITY','STARTS_ORCHESTRATION','CALLS_SUB_ORCHESTRATION','USES_DURABLE_ENTITY')"),
            "sdkEdges": q(c, "select count(*) from relationships where json_extract(provenance,'$[0].extractor')='AZURE_SDK_USAGE'"),
            "declaredResources": q(c, "select count(*) from entities where kind='AzureResource' and json_extract(metadata,'$.declaredIn') is not null and key like 'azure-resource|%'"),
            "aspireResources": q(c, "select count(*) from entities where key like 'azure-aspire|%'"),
            "exactNames": q(c, "select count(*) from entities where key like 'azure-resource|%' and json_extract(metadata,'$.nameState')='exact'"),
            "codeToIacLinks": q(c, "select count(*) from relationships where type='DECLARED_BY'"),
            "hostedOn": q(c, "select count(*) from relationships where type in ('HOSTED_ON','DEPLOYED_TO')"),
            "identityEdges": q(c, "select count(*) from relationships where type in ('USES_IDENTITY','HAS_ROLE_ON','AUTHENTICATES_WITH','READS_SECRET_FROM')"),
            "appSettings": q(c, "select count(*) from entities where json_extract(metadata,'$.source')='azure-app-settings'"),
            "azureUnresolved": q(c, "select count(*) from unresolved where resolver like 'azure.%'"),
        }
        rows.append(row)
        print(json.dumps(row), flush=True)

if __name__ == "__main__":
    main()
