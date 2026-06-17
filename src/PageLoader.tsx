type Props = {
  visible: boolean;
};

export function PageLoader({ visible }: Props) {
  return (
    <div
      className={`page-loader${visible ? " visible" : ""}`}
      aria-hidden={!visible}
    >
      <div className="page-loader-icon-wrap">
        <img
          src="/cotton-ai-icon.png"
          alt=""
          className="page-loader-icon"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      </div>
    </div>
  );
}
