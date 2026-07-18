# demo 
- [https://cable-guard.cloudflare-com-652.workers.dev/](https://cable-guard.cloudflare-com-652.workers.dev/)

## Labeling (Phase 0 harness)

Generate candidate incidents from the last 30 days:

```
npm run dev &      # start the worker
npm run materialize -- --source=all --lookback-days=30 --origin=http://127.0.0.1:8787
```

Open `http://localhost:8787/#mode=review` to label. Progress and imbalance are shown at the top of
the queue. Target: ≥ 200 labels (≥ 40 threat, ≥ 100 benign) before Phase 1 model fitting.
