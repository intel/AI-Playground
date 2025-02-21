"""
Metrics Collection Server
"""

import logging
import re
import sqlite3
import subprocess
import time
from threading import Thread

# Constant to adjust collection interval
COLLECTION_INTERVAL = 2

# Collector restart delay
COLLECTOR_RESTART_DELAY = 5

# Constant to define database storage
DATABASE = "metrics.db"

# Connect to the database
conn = sqlite3.connect(DATABASE)
cursor = conn.cursor()

# Create the Metrics table if it doesn't exist
cursor.execute(
    """
    CREATE TABLE IF NOT EXISTS Metrics (
        timestamp REAL,
        name TEXT,
        value REAL
    )
    """
)
conn.commit()

# Create the Prune trigger if it doesn't exists
cursor.execute(
    """
    CREATE TRIGGER IF NOT EXISTS Prune
    AFTER INSERT ON Metrics
    BEGIN
        DELETE FROM Metrics
        WHERE timestamp < (CAST(strftime('%s') as REAL) - 3600);
    END
    """
)
conn.commit()

# Close connection
cursor.close()


# Function to collect metrics
def collect_metrics():
    """
    Collection Loop
    """

    # Connect to the database
    _conn = sqlite3.connect(DATABASE)
    _cursor = _conn.cursor()

    # Initialize logger
    logger = logging.getLogger("metrics")

    # Print State
    logger.info("Collector Starting")

    # Spawn the collector
    collector_path = "tools/collector.ps1"
    command = [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        collector_path,
    ]

    while True:
        process = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )

        # Collect output while the process is running
        while process.poll() is None:
            for line in process.stdout:
                # Decode the line
                output = line.decode("utf-8").strip()
            
                # Print the output
                logger.info(output)

                # Regular expression pattern to capture the metrics
                pattern = (
                    r"metrics "
                    r"cpu-usage-percent=(?P<cpu_usage>[\d.]+),"
                    r"memory-usage-percent=(?P<memory_usage>[\d.]+),"
                    r"gpu-dedicated-memory-percent=(?P<gpu_memory>[\d.]+),"
                    r"gpu-copy-usage-percent=(?P<gpu_copy>[\d.]+),"
                    r"gpu-compute-usage-percent=(?P<gpu_compute>[\d.]+) "
                    r"(?P<epoch>\d+)"
                )

                # Match the pattern
                match = re.match(pattern, output)

                if match:
                    metrics = {
                        "cpu_usage_percent": float(match.group("cpu_usage")),
                        "memory_usage_percent": float(match.group("memory_usage")),
                        "gpu_dedicated_memory_percent": float(
                            match.group("gpu_memory")
                        ),
                        "gpu_copy_usage_percent": float(match.group("gpu_copy")),
                        "gpu_compute_usage_percent": float(match.group("gpu_compute")),
                        "epoch": int(match.group("epoch")),
                    }

                    metrics = [
                        (
                            metrics["epoch"],
                            "CPUTotalUsagePercentage",
                            metrics["cpu_usage_percent"],
                        ),
                        (
                            metrics["epoch"],
                            "MemoryTotalUsagePercentage",
                            metrics["memory_usage_percent"],
                        ),
                        (
                            metrics["epoch"],
                            "GPUDedicatedMemoryPercentage",
                            metrics["gpu_dedicated_memory_percent"],
                        ),
                        (
                            metrics["epoch"],
                            "GPUCopyUsagePercentage",
                            metrics["gpu_copy_usage_percent"],
                        ),
                        (
                            metrics["epoch"],
                            "GPUComputeUsagePercentage",
                            metrics["gpu_compute_usage_percent"],
                        ),
                    ]

                    # Store the Metrics
                    for metric in metrics:
                        _cursor.execute(
                            """
                            INSERT INTO Metrics (timestamp, name, value)
                            VALUES (?, ?, ?)
                            """,
                            metric,
                        )
                    _conn.commit()

                # Sleep for COLLECTION_INTERVAL seconds
                time.sleep(COLLECTION_INTERVAL)

        # Log termination
        logger.info(F"Collector Terminated, restarting in {COLLECTOR_RESTART_DELAY} seconds")
        time.sleep(COLLECTOR_RESTART_DELAY)


# Create a daemon thread
daemon = Thread(target=collect_metrics, daemon=True, name="Monitor")

# Start collecting metrics
daemon.start()

def read_available_counters():
    """
    Root endpoint returns list of available metrics
    """

    # Open database connection
    _conn = sqlite3.connect(DATABASE)
    _cursor = _conn.cursor()
    _results = None

    try:
        # Get the list of available values in the database
        _cursor.execute(
            """
            SELECT DISTINCT name
            FROM Metrics
            """
        )
        rows = _cursor.fetchall()
        _results = [row[0] for row in rows]
    except Exception as e:
        raise e
    finally:
        _cursor.close()

    return _results


def read_performance_counter(metric_name: str):
    """
    Endpoint to return the metric values
    """

    # Open database connection
    _conn = sqlite3.connect(DATABASE)
    _cursor = _conn.cursor()
    _results = None

    try:
        # Get a timestamp from five minutes ago
        timestamp = time.time() - 300

        # Get the list of available values in the database
        _cursor.execute(
            """
            SELECT * FROM Metrics WHERE name = :name and timestamp > :timestamp
            """,
            {"name": metric_name, "timestamp": timestamp},
        )
        rows = _cursor.fetchall()
        _results = [{"timestamp": row[0], "value": row[2]} for row in rows]
    except Exception as e:
        raise e
    finally:
        _cursor.close()

    return _results
