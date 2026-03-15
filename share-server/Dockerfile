FROM golang:1.23-alpine AS builder
RUN apk add --no-cache gcc musl-dev
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 go build -o share-server .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates sqlite
COPY --from=builder /app/share-server /usr/local/bin/
COPY --from=builder /app/templates /app/templates
WORKDIR /app
EXPOSE 8080
CMD ["share-server"]
