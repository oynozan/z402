import Link from "next/link";
import { Badge } from "@/components/chrome";

export default function NotFound() {
  return (
    <section className="section">
      <div className="frame">
        <div className="head">
          <div className="head-main">
            <Badge label="404" />
            <h1 className="title">
              <span className="title-lead">Nothing here.</span> The services are one click away.
            </h1>
          </div>
          <div className="head-cell" />
          <div className="head-cell head-links">
            <Link className="link-cell" href="/services">
              Services
            </Link>
            <Link className="link-cell" href="/">
              Home
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
