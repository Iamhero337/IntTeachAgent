import io
import pypdf


def extract_text_from_pdf(content: bytes) -> str:
    reader = pypdf.PdfReader(io.BytesIO(content))
    pages = [page.extract_text() or "" for page in reader.pages]
    return "\n".join(pages).strip()
