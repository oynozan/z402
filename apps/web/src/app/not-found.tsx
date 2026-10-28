import Link from "next/link";
import { Chip } from "@/components/chrome";

export default function NotFound() {
  return (
    <section className="band">
      <div className="frame head lost">
        <Chip label="404" />
        <h1>Nothing here.</h1>
        <Link className="btn btn-lg" href="/">
          Home
        </Link>
      </div>
    </section>
  );
}
