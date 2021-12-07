FROM conda/miniconda3
ENV DEBIAN_FRONTEND=noninteractive 

RUN conda create -n entwine -c conda-forge entwine

RUN apt update
RUN apt upgrade -y
RUN apt install -y curl
RUN curl -fsSL https://deb.nodesource.com/setup_16.x | bash -
RUN apt-get install -y nodejs
RUN npm install ept-tools -g
RUN apt-get install -y awscli

WORKDIR /app
COPY . /app
RUN npm install
EXPOSE 8081
CMD node api.js


