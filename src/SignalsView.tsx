export function SignalsView() {
  return (
    <div className="signals-coming-soon">
      <div className="signals-glow" />
      <div className="signals-content">
        <div className="signals-badge">
          <span className="signals-badge-dot" />
          In Development
        </div>
        <h1 className="signals-title">
          Cotton AI <em>Signals</em>
        </h1>
        <p className="signals-description">
          Proprietary buy, wait, and hedge recommendations powered by our
          institutional-grade fixation dataset and advanced machine learning
          models.
        </p>

        <div className="signals-preview">
          <div className="signals-preview-header">
            <div className="signals-preview-dots">
              <span />
              <span />
              <span />
            </div>
            <span className="signals-preview-title">Preview</span>
          </div>
          <div className="signals-preview-body">
            <div className="signal-row-preview">
              <div className="signal-indicator-buy" />
              <div className="signal-row-content">
                <div className="signal-row-meta">
                  <span className="signal-type-buy">Buy</span>
                  <span className="signal-conf-badge">87%</span>
                </div>
                <p>
                  Fix <strong>Brazilian M36 G5 28GPT</strong> at{" "}
                  <strong>70 c/lb on Dec26</strong>
                </p>
              </div>
            </div>
            <div className="signal-row-preview">
              <div className="signal-indicator-hedge" />
              <div className="signal-row-content">
                <div className="signal-row-meta">
                  <span className="signal-type-hedge">Hedge</span>
                  <span className="signal-conf-badge">72%</span>
                </div>
                <p>
                  Buy <strong>Dec26 67-strike puts</strong> — IV 18% below avg
                </p>
              </div>
            </div>
            <div className="signal-row-preview">
              <div className="signal-indicator-wait" />
              <div className="signal-row-content">
                <div className="signal-row-meta">
                  <span className="signal-type-wait">Wait</span>
                  <span className="signal-conf-badge">64%</span>
                </div>
                <p>
                  Delay <strong>US M36 G5</strong> purchases — USDA report due
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="signals-notify">
          <p>We'll notify you when Cotton AI Signals launches.</p>
        </div>
      </div>
    </div>
  );
}
