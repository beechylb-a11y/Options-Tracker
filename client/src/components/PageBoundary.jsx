import React from 'react';

// A render error in one page used to unmount the whole app: Portfolio Risk crashed on
// one position with no greeks (27 Oct) and the screen went blank, sidebar and all.
// Now the page says what broke and the rest of the app keeps working. Keyed by tab in
// App, so moving to another page clears it. (Oct 2026.)
export default class PageBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[page]', this.props.name, error, info && info.componentStack); }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div data-testid="page-error" className="card" style={{ borderColor: '#6e2427' }}>
        <div style={{ color: '#f85149', fontWeight: 700, fontSize: 15 }}>{this.props.name || 'This page'} hit an error and could not draw.</div>
        <div className="mono" style={{ color: '#e6edf3', fontSize: 12.5, marginTop: 6 }}>{String(error && error.message || error)}</div>
        <div style={{ color: '#8b949e', fontSize: 12.5, marginTop: 6 }}>The other pages still work. Send this message to get it fixed.</div>
        <button onClick={() => this.setState({ error: null })} style={{ marginTop: 10, fontSize: 13, color: '#58a6ff', border: '1px solid #1f6feb', borderRadius: 6, padding: '4px 10px' }}>Try again</button>
      </div>
    );
  }
}
