// Placeholder for screens later features build (6b search, 6c today's openings, 6d week schedule).
export function ComingNext({ title, note }: { title: string; note: string }) {
  return (
    <main className="page">
      <section className="card placeholder" aria-labelledby="coming-next-h">
        <h1 id="coming-next-h" style={{ fontSize: 24 }}>
          {title}
        </h1>
        <p className="muted">Coming next. {note}</p>
      </section>
    </main>
  );
}
