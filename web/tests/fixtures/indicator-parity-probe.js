/* Synthetic Python oracle, actual pinned native renderer. No app/provider claim. */
window.parity = {
  delay: false, failures: false, revision: 1, correction: 0, reads: [], events: [],
  initialize() {
    this.coordinator = chartIndicatorCoordinator(widget, parityData.catalog, {
      identity: {
        binding: () => ({revision: 'parity-fixture-1', inputRevision: this.revision,
          correctionVersion: this.correction, calculationStart: parityData.bars[0].start}),
        chartTime: bar => bar.start,
      },
      read: async (symbol, resolution, args) => {
        this.reads.push({symbol, resolution, args, at: performance.now()});
        if (this.delay) await new Promise(resolve => (this.waiting ||= []).push(resolve));
        if (this.failures) throw Error('Synthetic delayed failure');
        const indicators = args.indicators.map(spec => {
          const params = Object.fromEntries(Object.entries(spec.params).sort(([a], [b]) => a.localeCompare(b)));
          const result = parityData.results[spec.name + ':' + JSON.stringify(params)];
          if (!result) throw Error('Missing exact Python oracle for ' + JSON.stringify(spec));
          return result;
        });
        return {bars: parityData.bars, indicators, input_revision: this.revision, has_more: false};
      },
      report: error => this.events.push({type: 'error', error: String(error), at: performance.now()}),
      status: (consumer, value) => this.events.push({type: 'status', id: consumer.id, value, at: performance.now()}),
    });
  },
  async add(name = 'LWMA', params = {period: 5}) {
    this.id = await widget.activeChart().createStudy('守望 Python ' + name, false, false, params);
    await this.coordinator.sync();
    return this.id;
  },
  sample() {
    const chart = widget.activeChart();
    const study = this.id && chart._chartWidget.model().model().dataSourceForId(this.id);
    return {size: study?.data().size(), last: study?.data().last()?.value,
      scope:this.id && MWNativeIndicatorResults.scope(chart,this.id),
      inputs: this.id && chart.getStudyById(this.id)?.getInputValues(), at: performance.now()};
  },
  release() { this.delay = false; for (const resolve of this.waiting || []) resolve(); this.waiting = []; },
};
