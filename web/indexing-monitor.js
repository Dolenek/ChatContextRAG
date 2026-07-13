class IndexingMonitor {
  constructor(backend, events) {
    this.backend = backend;
    this.events = events;
    this.activeJobs = new Set();
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
      do {
        await delay(1000);
        job = await this.backend.get(`/indexing/jobs/${jobId}`);
        this.events.publish("indexing", job);
      } while (["queued", "running"].includes(job.status));
    } catch (error) {
      this.events.publish("indexing-error", { job_id: jobId, detail: error.message });
    } finally {
      this.activeJobs.delete(jobId);
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

module.exports = { IndexingMonitor };
