// The existing poster stays visible while the optional playback engine downloads.
export default function FilmLoading({ poster, playing }: { poster: string; playing: boolean }) {
  return <div className="site-film-loading"><img src={poster} alt=""/>{playing && <span className="site-film-buffering" role="status" aria-label="正在缓冲 / Buffering"/>}</div>
}
