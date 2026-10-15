SELECT sum((mod(i,1000)::double precision * 1.000001 +
        sqrt((mod(i,997) + 1)::double precision)) / (mod(i,97) + 1))
        FROM generate_series(1,3000000) AS t(i);
