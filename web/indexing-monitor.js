class IndexingMonitor {
  constructor(backend, events, options = {}) {
    this.backend = backend;
    this.events = events;
    this.activeJobs = new Set();
    this.pollIntervals = options.pollIntervals || [1000, 2500, 5000];
  }

  start(jobId) {
    if (!jobId || this.activeJobs.has(jobId)) return;
    this.activeJobs.add(jobId);
    void this.poll(jobId);
  }

  startSessionJobs(session) {
    const jobIds = session.indexing_job_ids?.length
      ? session.indexing_job_ids : [session.indexing_job_id].filter(Boolean);
    jobIds.forEach((jobId) => this.start(jobId));
  }

  async poll(jobId) {
    try {
      let job;
      let attempt = 0;
      do {
        await delay(this.intervalFor(attempt));
        job = await this.backend.get(`/indexing/jobs/${jobId}`);
        this.events.publish("indexing", job);
        attempt += 1;
      } while (["queued", "running"].includes(job.status));
    } catch (error) {
      this.events.publish("indexing-error", { job_id: jobId, detail: error.message });
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  intervalFor(attempt) {
    return this.pollIntervals[Math.min(attempt, this.pollIntervals.length - 1)];
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

module.exports = { IndexingMonitor };
