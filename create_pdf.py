from reportlab.pdfgen import canvas
import os

pdf_path = os.path.join(r"d:\antigravity\translate", "test.pdf")
c = canvas.Canvas(pdf_path)
c.drawString(100, 750, "Hello, this is a test PDF for translation.")
c.drawString(100, 730, "Testing the PDF parsing functionality.")
c.save()
print(f"Created PDF at {pdf_path}")
