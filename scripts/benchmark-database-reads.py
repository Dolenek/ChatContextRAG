import argparse
import json
import statistics
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.request import urlopen


def request_json(base_url: str, path: str) -> dict:
    started_at = time.perf_counter()
    with urlopen(f"{base_url.rstrip('/')}{path}", timeout=30) as response:
        json.load(response)
    return {"milliseconds": (time.perf_counter() - started_at) * 1000}


def measure(operation, iterations: int) -> list:
    for _iteration in range(3):
        operation()
    return [operation() for _iteration in range(iterations)]


def summarize(samples: list) -> dict:
    milliseconds = sorted(sample["milliseconds"] for sample in samples)
    percentile_index = max(0, round(len(milliseconds) * 0.95) - 1)
    return {
        "p50_ms": round(statistics.median(milliseconds), 2),
        "p95_ms": round(milliseconds[percentile_index], 2),
    }


def parallel_database_read(base_url: str) -> dict:
    started_at = time.perf_counter()
    with ThreadPoolExecutor(max_workers=2) as executor:
        breakdowns = executor.submit(request_json, base_url, "/database/breakdowns")
        chunks = executor.submit(request_json, base_url, "/database/chunks?limit=50")
        breakdowns.result()
        chunks.result()
    return {"milliseconds": (time.perf_counter() - started_at) * 1000}


def improvement(old_result: dict, new_result: dict) -> float:
    baseline = old_result["p95_ms"]
    return round((baseline - new_result["p95_ms"]) / baseline * 100, 2) if baseline else 0


def run(base_url: str, iterations: int) -> dict:
    old_samples = measure(
        lambda: request_json(base_url, "/database/overview?limit=50&offset=0"), iterations,
    )
    status_samples = measure(
        lambda: request_json(base_url, "/database/status"), iterations,
    )
    detail_samples = measure(lambda: parallel_database_read(base_url), iterations)
    old_result = summarize(old_samples)
    status_result = summarize(status_samples)
    detail_result = summarize(detail_samples)
    return {
        "legacy_overview": old_result,
        "startup_status": status_result,
        "parallel_database_details": detail_result,
        "startup_p95_improvement_percent": improvement(old_result, status_result),
        "database_p95_improvement_percent": improvement(old_result, detail_result),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark database read endpoints.")
    parser.add_argument("--base-url", default="http://127.0.0.1:8765")
    parser.add_argument("--iterations", type=int, default=20)
    arguments = parser.parse_args()
    if arguments.iterations < 1:
        parser.error("--iterations must be positive")
    print(json.dumps(run(arguments.base_url, arguments.iterations), indent=2))


if __name__ == "__main__":
    main()
