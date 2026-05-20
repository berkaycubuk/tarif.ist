# syntax=docker/dockerfile:1.7

# Build stage: compile a static binary. No CGO so the result runs on
# distroless/static without dragging glibc along.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY backend/go.mod ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/livepos .

# Runtime stage: distroless static. Includes CA certs (needed for the
# https://api.ibb.gov.tr/ disruptions fetch) and nothing else.
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/livepos /app/livepos
# Transit data is gitignored but generated locally by `npm run sync:data` /
# `npm run sync:gtfs` before building the image.
COPY public/data /app/data

ENV ADDR=:8080 \
    DATA_DIR=/app/data

EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/app/livepos"]
