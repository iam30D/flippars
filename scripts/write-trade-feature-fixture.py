"""Refresh small synthetic parity cases; no market data, training, or network I/O."""

import argparse
from datetime import UTC, datetime, timedelta
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import sys


def main() -> None:
    repo = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output != repo / "apps/api/test/fixtures/trade-feature-parity.json":
        raise ValueError("Only the reviewed synthetic fixture path is accepted")

    source = repo / "apps/model-training/src"
    sys.path.insert(0, str(source))
    from flippars_model_training import pipeline

    cases = []
    for signal_type, duration, decision_offset in (
        ("FIVE_MINUTE_EARLY_DIRECTION", 300, 30),
        ("FIVE_MINUTE_REVERSAL", 300, 30),
        ("FIFTEEN_MINUTE_REVERSAL", 900, 300),
    ):
        base = datetime(2026, 1, 1, tzinfo=UTC)
        raw = [(base - timedelta(seconds=1), Decimal("20000"), Decimal("0.1"))]
        for index in range(14):
            start = base + timedelta(seconds=index * duration)
            opening = Decimal(20040 + index * 3)
            for offset, delta, quantity in (
                (0, 0, "0.1"), (14, 11 + index % 4, "0.2"),
                (duration // 2, -9 - index % 3, "0.3"),
                (duration - 1, 5, "0.4"),
            ):
                raw.append((start + timedelta(seconds=offset), opening + delta, Decimal(quantity)))
            if index == 13:
                cutoff = start + timedelta(seconds=decision_offset)
                raw.extend((
                    (cutoff - timedelta(microseconds=1), opening + Decimal("20.125"), Decimal("0.125")),
                    (cutoff, opening * 3, Decimal("2")),
                    (cutoff + timedelta(microseconds=1), opening / 2, Decimal("3")),
                ))
        raw.append((base + timedelta(seconds=14 * duration), Decimal("20100"), Decimal("0.1")))
        raw.sort(key=lambda item: item[0])
        trades = []
        inputs = []
        for trade_id, (event, price, quantity) in enumerate(raw, start=1):
            buyer_is_maker = trade_id % 2 == 0
            trades.append(pipeline.Trade(
                event_time=event, trade_id=str(trade_id), price=float(price),
                quantity=float(quantity), quote_quantity=float(price * quantity),
                is_buyer_maker=buyer_is_maker, source_file="SYNTHETIC_PARITY_ONLY",
            ))
            received = event.replace(microsecond=event.microsecond // 1000 * 1000)
            inputs.append({
                "tradeId": str(trade_id),
                "eventAt": event.isoformat(timespec="microseconds").replace("+00:00", "Z"),
                "receivedAt": received.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "price": str(price), "quantity": str(quantity), "buyerIsMaker": buyer_is_maker,
            })
        target_start = base + timedelta(seconds=13 * duration)
        decision = target_start + timedelta(seconds=decision_offset)
        options = pipeline.DatasetOptions(
            signal_type=signal_type, deadband_bps=5.0, timeframe_minutes=duration // 60,
            decision_cadence_seconds=15,
            minimum_lead_time_seconds=30 if duration == 900 else 15,
        )
        rows, gaps = pipeline.examples_from_trades(trades, options)
        if gaps:
            raise ValueError("Synthetic fixture unexpectedly contains gaps")
        row = next(row for row in rows if row["decisionAt"] == pipeline.format_timestamp(decision))
        cases.append({
            "signalType": signal_type, "windowStart": pipeline.format_timestamp(target_start),
            "decisionAt": pipeline.format_timestamp(decision),
            "observedThrough": pipeline.format_timestamp(target_start + timedelta(seconds=duration + 1)),
            "trades": inputs, "expectedFeatures": row["features"],
            "expectedCurrentRelation": row["currentRelation"],
            "expectedCandidateEligible": row["candidateEligible"], "expectedLabel": row["label"],
        })
    result = {
        "schemaVersion": "flippars.synthetic-feature-parity/1",
        "scope": "SYNTHETIC_ONLY",
        "pipelineSha256": hashlib.sha256((source / "flippars_model_training/pipeline.py").read_bytes()).hexdigest(),
        "pythonVersion": sys.version.split()[0],
        "numpyVersion": pipeline.np.__version__, "cases": cases,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print("Wrote three synthetic parity cases; no model was trained or enabled.")


if __name__ == "__main__":
    main()
