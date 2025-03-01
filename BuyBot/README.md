# ICP-BuyBot

## dev run:
npx tsx src/index.ts

## set up dev db:
docker run -d --name bbtest -p 5432:5432 -e POSTGRES_PASSWORD=password -e PGDATA=/var/lib/postgresql/data/pgdata -v /custom/mount:/var/lib/postgresql/data postgres

## check dev db
docker exec -it bbtest psql -U postgres